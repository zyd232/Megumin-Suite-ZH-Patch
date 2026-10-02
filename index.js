// ─────────────────────────────────────────────────────────────────────────────
// Megumin Suite 中文补丁 · 引擎
//
// 原理：
//   1. 以 MutationObserver 监听整页 DOM，只处理「作用域内」的节点
//      （Megumin Suite 的设置弹窗、右侧追踪面板、在场角色栏、
//        聊天气泡里的 .meg-* 区块、以及全局 toast）。
//   2. 文本节点 / title / aria-label / placeholder 的值做归一化精确匹配
//      （trim + 空白折叠），命中词典才替换 —— 未命中的字符串原样保留，
//      绝不猜测、绝不改动输入框内容与模型生成内容。
//   3. 额外包装 window.confirm / window.alert，让原生弹框也走词典。
//   4. CoT 中文：把 V10/V9/V8/V7 中文推理脚本注入上游共享 models 注册表
//      （同一 ES 模块实例），并在 V7+ 引擎的「推理语言」网格中注入
//      「Mandarin (中文)」卡片；点击后走上游语言卡片完全相同的写入路径：
//      先更新内存共享对象 localProfile.model，再调扩展自己的
//      saveProfileToMemory() 落盘 —— 保证弹窗「保存并关闭」（同样调用
//      saveProfileToMemory()，把内存 localProfile 深写回持久化 profile）
//      序列化的是同一个中文值，不会被旧英文值覆盖。
//
// 不修改 Megumin-Suite 任何文件；上游更新后未收录的新文案自动回落英文，
// 在控制台运行 MEG_ZH.collect() 可导出全部未翻译字符串用于补词典。
// ─────────────────────────────────────────────────────────────────────────────

import { TEXT_DICT, ATTR_DICT } from "./src/dict.js";
import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { COT_ZH } from "./src/cot-zh.js";

const VERSION = "1.1.0";

// ── CoT 中文：注入上游共享注册表 ────────────────────────────────────────────
// /scripts/extensions/third-party/Megumin-Suite/data/cot/index.js 导出的
// models 数组，与生成时 buildBaseDict.js 用来查 [[COT]] 的
// hardcodedLogic.models 是同一个对象引用（同一 ES 模块实例）。推入中文
// 条目后，V7+ 引擎的「推理语言」即有中文可选；上游文件本身零改动。
const COT_ZH_IDS = new Set(COT_ZH.map(t => t.id));
const KNOWN_LANGS = new Set(["english", "arabic", "spanish", "french", "zh", "ru", "jp", "pt"]);

let COT_MODELS = null;
try {
    const reg = await import("../Megumin-Suite/data/cot/index.js");
    if (Array.isArray(reg.models)) COT_MODELS = reg.models;
} catch (e) {
    COT_MODELS = null; // 上游未安装/未加载：仅 CoT 功能不可用，词典翻译不受影响
}
if (COT_MODELS) {
    for (const t of COT_ZH) {
        if (!COT_MODELS.some(m => m.id === t.id)) COT_MODELS.push(t);
    }
}

// 上游内存状态与保存入口（与上游自身是同一 ES 模块实例）：
//   state.js   → localProfile（live binding，扩展共享的内存 profile 对象；
//                initProfile 换对象后导入方自动看到新对象，
//                属性修改 localProfile.foo = x 是上游认可的写法）
//   profile.js → saveProfileToMemory()（语言卡片与「保存并关闭」共用的落盘入口）
let MS_STATE = null;
let MS_PROFILE = null;
try {
    MS_STATE = await import("../Megumin-Suite/src/core/state.js");
} catch (e) { MS_STATE = null; }
try {
    MS_PROFILE = await import("../Megumin-Suite/src/core/profile.js");
} catch (e) { MS_PROFILE = null; }

// 作用域：只翻译 Megumin Suite 自己的 UI。
// #toastr 是 ST 全局 toast 容器，靠「整句精确匹配」保证只命中 Megumin 的提示。
const SCOPE_SELECTOR = [
    "#prompt-slot-modal-overlay", // 设置弹窗（所有标签页）
    "#prompt-slot-fixed-btn",     // 右下角悬浮设置入口
    "#meg-sp-panel",              // 右侧追踪面板
    "#meg-sp-fab",                // 追踪面板悬浮按钮
    "#meg-pb-wrapper",            // 在场角色栏
    ".meg-block",                 // 聊天气泡里的追踪区块
    ".meg-ws",
    ".meg-dice",
    ".meg-chat",
    ".meg-vault",
    ".meg-iv",
    ".meg-npcupd",
    "#toastr",
].join(",");

// 兜底：凡带 meg- 前缀 class 的元素一律视为 Megumin 作用域。
const MEG_CLASS = '[class*="meg-"]';
const FULL_SCOPE = SCOPE_SELECTOR + ", " + MEG_CLASS;

const TRANSATTRS = ["title", "aria-label", "placeholder"];
const SKIP_PARENT = new Set(["PRE", "TEXTAREA", "INPUT", "SELECT", "SCRIPT", "STYLE", "IFRAME"]);

// 归一化：trim + 连续空白折叠为单个空格。
// 上游模板字符串里的换行/缩进差异不会破坏匹配；替换后按原文首尾空白回填。
function norm(s) {
    return String(s).trim().replace(/\s+/g, " ");
}

const translatedNodes = new WeakSet();

function inScope(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || el.nodeType !== 1) return false;
    try {
        return !!(el.closest(SCOPE_SELECTOR) || el.closest(MEG_CLASS));
    } catch (e) {
        return false;
    }
}

function translateTextNode(node) {
    if (node.nodeType !== 3 || translatedNodes.has(node)) return false;
    const parent = node.parentElement;
    if (!parent || !parent.isConnected) return false;
    if (SKIP_PARENT.has(parent.tagName)) return false;
    const raw = node.nodeValue;
    if (!raw || !raw.trim()) return false;
    if (!inScope(node)) return false;
    const zh = TEXT_DICT.get(norm(raw));
    if (zh === undefined) return false;
    const lead = raw.match(/^\s*/)[0];
    const trail = raw.match(/\s*$/)[0];
    node.nodeValue = lead + zh + trail;
    translatedNodes.add(node);
    return true;
}

function translateAttrs(el) {
    if (!el || el.nodeType !== 1 || !el.getAttribute) return;
    if (!inScope(el)) return;
    for (const a of TRANSATTRS) {
        const v = el.getAttribute(a);
        if (!v || !v.trim()) continue;
        const zh = ATTR_DICT.get(norm(v));
        if (zh !== undefined) el.setAttribute(a, zh);
    }
}

function walkText(root) {
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
            return (n.nodeValue && n.nodeValue.trim()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
    });
    let n;
    while ((n = tw.nextNode())) translateTextNode(n);
}

function processNode(node) {
    if (node.nodeType === 1) {
        translateAttrs(node);
        walkText(node);
        const qs = node.querySelectorAll ? node.querySelectorAll("[title],[aria-label],[placeholder]") : [];
        for (const el of qs) translateAttrs(el);
    } else if (node.nodeType === 3) {
        translateTextNode(node);
    }
}

// ── 原生弹框包装：Megumin 的 confirm()/alert() 文案也走词典 ────────────────
function wrapNative(fnName) {
    const native = window[fnName];
    if (typeof native !== "function" || native.__megZhWrapped) return;
    const wrapped = function (message) {
        const key = norm(message);
        const zh = TEXT_DICT.get(key);
        const args = Array.prototype.slice.call(arguments);
        args[0] = zh !== undefined ? zh : message;
        return native.apply(window, args);
    };
    wrapped.__megZhWrapped = true;
    window[fnName] = wrapped;
}
wrapNative("confirm");
wrapNative("alert");

// ── CoT 中文 UI：在「推理语言」网格中注入中文卡片 ────────────────────────────
// 上游 coreAndCot.js 对 v7+/v8+/v9+/v10 引擎只渲染一张 English 卡片，点语言
// 卡片的动作是：localProfile.model = cot-<engine>-<lang>（内存共享对象）
// + saveProfileToMemory()（落盘）+ 重渲染。中文卡片做完全相同的事。
// 只写持久化配置而不更新 localProfile 的话，弹窗「保存并关闭」会把内存里
// 的旧英文值深写回配置，覆盖中文选择（v1.0.1 的缺陷，v1.0.2 修复）。
//
// 生成时 buildBaseDict.js 按 localProfile.model（内存值）查注册表，所以
// 更新 live 对象后下一条消息即生效，无需刷新或切换聊天。
//
// 兜底路径的键解析与上游 src/core/keys.js getCharacterKey() + profile.js
// 载入级联一致：
//   group_<id> → (saveMode=chat → chat::<id>) → 角色头像名 → "default"，
// 取其中已存有 profile 的键——即 initProfile 当前加载的那份。
function megSettings() {
    try { return extension_settings["Megumin-Suite"]; } catch (e) { return null; }
}

function resolveTargetKey() {
    const ms = megSettings();
    const profiles = (ms && ms.profiles) || {};
    let ctx = {};
    try { ctx = getContext() || {}; } catch (e) { /* 忽略 */ }
    const saveMode = (ms && ms.globalSettings && ms.globalSettings.saveMode) || "character";
    const candidates = [];
    if (ctx.groupId !== undefined && ctx.groupId !== null) candidates.push("group_" + ctx.groupId);
    else if (saveMode === "chat" && typeof ctx.chatId === "string" && ctx.chatId.trim() !== "") candidates.push("chat::" + ctx.chatId);
    let avatar = null;
    try {
        const cid = ctx.characterId;
        if (cid !== undefined && cid !== null && ctx.characters && ctx.characters[cid]) avatar = ctx.characters[cid].avatar;
    } catch (e) { /* 忽略 */ }
    if (avatar) candidates.push(avatar);
    for (const k of candidates) if (profiles[k]) return k;
    return "default";
}

function toZhModelId(base) {
    if (typeof base !== "string" || !base.trim()) return null;
    const dash = base.lastIndexOf("-");
    let type = base;
    if (dash > 0 && KNOWN_LANGS.has(base.slice(dash + 1))) type = base.slice(0, dash);
    const zhId = type + "-zh";
    return COT_ZH_IDS.has(zhId) ? zhId : null;
}

function persistedCotModel() {
    // 优先读上游内存 profile（设置弹窗与生成路径实际使用的值）；
    // state.js 不可用时回落到持久化配置。
    try {
        const p = MS_STATE && MS_STATE.localProfile;
        if (p && typeof p.model === "string") return p.model;
    } catch (e) { /* 忽略 */ }
    const ms = megSettings();
    if (!ms || !ms.profiles) return "";
    const p = ms.profiles[resolveTargetKey()] || ms.profiles["default"];
    return (p && typeof p.model === "string") ? p.model : "";
}

const ZH_CARD_LABELS = new Set(["Mandarin (中文)", "普通话（中文）"]);

function ensureZhLangCards() {
    if (!document.getElementById("prompt-slot-modal-overlay")) return; // 设置弹窗未开，零开销
    let heads = [];
    try { heads = document.querySelectorAll("#prompt-slot-modal-overlay .wstyle-section-head"); } catch (e) { return; }
    for (const head of heads) {
        const t = norm(head.textContent || "");
        if (t !== "Reasoning Language" && t !== "推理语言") continue;
        const grid = head.nextElementSibling;
        if (!grid || !grid.classList || !grid.classList.contains("mtab-card-grid")) continue;
        syncZhLangCard(grid);
    }
}

function syncZhLangCard(grid) {
    // 网格已有中文卡片（v1/v2/v6 旧引擎原生带 8 张语言卡）→ 不重复注入。
    const titles = grid.querySelectorAll(".mtab-eng-card .ecard-title");
    for (const el of titles) {
        const s = el.querySelector("span");
        if (s && ZH_CARD_LABELS.has(norm(s.textContent || ""))) return;
    }
    let zhCard = grid.querySelector(".meg-zh-card");
    if (!zhCard) {
        zhCard = buildZhLangCard();
        grid.appendChild(zhCard);
    }
    updateZhLangCardState(zhCard, grid);
}

function buildZhLangCard() {
    const card = document.createElement("div");
    card.className = "mtab-eng-card meg-zh-card";
    card.innerHTML =
        '<div class="ecard-accent"></div>' +
        '<div class="ecard-body" style="padding:12px 16px;">' +
        '<div class="ecard-title" style="font-size:0.88rem;">' +
        "<span>Mandarin (中文)</span>" +
        '<span class="ecard-badge meg-zh-check" style="background:rgba(245,158,11,0.15);color:var(--gold);display:none;"><i class="fa-solid fa-check"></i></span>' +
        "</div></div>";
    card.addEventListener("click", () => onZhLangClick(card));
    return card;
}

function updateZhLangCardState(zhCard, grid) {
    const isZh = persistedCotModel().endsWith("-zh");
    zhCard.classList.toggle("active", isZh);
    const badge = zhCard.querySelector(".meg-zh-check");
    if (badge) badge.style.display = isZh ? "" : "none";
    if (isZh) {
        // 视觉上去掉原生 English 卡的选中态（上游下次重渲染会自行恢复布局）。
        for (const other of grid.querySelectorAll(".mtab-eng-card")) {
            if (other === zhCard) continue;
            other.classList.remove("active");
            const b = other.querySelector(".ecard-badge");
            if (b) b.style.display = "none";
        }
    }
}

function onZhLangClick(zhCard) {
    try {
        if (!COT_MODELS) {
            if (window.toastr) toastr.warning("中文推理脚本未就绪：Megumin-Suite 未加载。");
            return;
        }
        const ms = megSettings();
        if (!ms || !ms.profiles) {
            if (window.toastr) toastr.warning("Megumin-Suite 配置尚未初始化。");
            return;
        }
        // 当前引擎基座：优先取内存 profile（用户正在看的这份），
        // state.js 不可用时回落到持久化配置。
        let base = "";
        try {
            const lp = MS_STATE && MS_STATE.localProfile;
            if (lp && typeof lp.model === "string") base = lp.model;
        } catch (e) { /* 忽略 */ }
        if (!base) {
            const k0 = resolveTargetKey();
            base = (ms.profiles[k0] && typeof ms.profiles[k0].model === "string" && ms.profiles[k0].model) || "cot-v1-english";
        }
        const zhId = toZhModelId(base);
        if (!zhId) {
            if (window.toastr) toastr.warning("当前推理引擎暂无中文脚本（目前覆盖 V7–V10 系列）。");
            return;
        }
        if (MS_STATE && MS_PROFILE && typeof MS_PROFILE.saveProfileToMemory === "function" && MS_STATE.localProfile) {
            // 与上游语言卡片完全相同的写入路径：先更新内存共享对象，
            // 再走扩展自己的落盘入口（内部处理 key 归属、拒绝错键保存、
            // 「已保存 ✓」指示）。之后「保存并关闭」序列化的也是 zh 值。
            MS_STATE.localProfile.model = zhId;
            MS_PROFILE.saveProfileToMemory();
        } else {
            // 兜底（state.js/profile.js 不可用——实际不会发生）：直接写配置。
            const key = resolveTargetKey();
            if (!ms.profiles[key]) ms.profiles[key] = { model: "cot-v1-english" };
            ms.profiles[key].model = zhId;
            saveSettingsDebounced();
        }
        const grid = zhCard.parentElement;
        if (grid) updateZhLangCardState(zhCard, grid);
        if (window.toastr) toastr.success(`推理语言已设为中文（${zhId}），下一条消息即生效。`);
    } catch (e) {
        try { if (window.toastr) toastr.error("切换推理语言失败：" + ((e && e.message) || e)); } catch (e2) { /* 忽略 */ }
    }
}

// ── 观察器 ─────────────────────────────────────────────────────────────────
const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
        if (m.type === "characterData") {
            translateTextNode(m.target);
        } else if (m.type === "attributes") {
            translateAttrs(m.target);
        } else if (m.type === "childList") {
            for (const n of m.addedNodes) processNode(n);
        }
    }
    ensureZhLangCards(); // 每批一次：设置弹窗未开时内部直接返回，零开销
});

observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: TRANSATTRS,
});

// 初始扫描：插件加载时已渲染出的内容也要翻译。
function refreshAll() {
    let roots;
    try {
        roots = document.querySelectorAll(FULL_SCOPE);
    } catch (e) {
        return;
    }
    for (const r of roots) processNode(r);
    ensureZhLangCards();
}
refreshAll();

// ── 控制台 API：补词典用 ───────────────────────────────────────────────────
window.MEG_ZH = {
    version: VERSION,
    /** 词典规模。 */
    stats: () => ({ text: TEXT_DICT.size, attr: ATTR_DICT.size }),
    /** 运行时补一条文本条目，并立即重扫。 */
    addText: (en, zh) => { TEXT_DICT.set(norm(en), zh); refreshAll(); },
    /** 运行时补一条属性条目，并立即重扫。 */
    addAttr: (en, zh) => { ATTR_DICT.set(norm(en), zh); refreshAll(); },
    /** 手动重扫当前可见作用域。 */
    refresh: refreshAll,
    /** CoT 中文功能诊断：注册表是否注入、live 绑定是否可用、目标配置键、当前持久化的 model。 */
    cotStatus: () => ({
        ready: !!COT_MODELS,
        liveBindings: {
            // state.js/profile.js 是否成功连上上游同一模块实例。
            // 两者皆 true 时点击走「内存 + saveProfileToMemory」主路径（不会被
            // 「保存并关闭」覆盖）；否则回落直写配置（旧行为，可能被覆盖）。
            state: !!MS_STATE,
            save: !!(MS_PROFILE && typeof MS_PROFILE.saveProfileToMemory === "function"),
        },
        injected: COT_MODELS ? COT_ZH.filter(t => COT_MODELS.some(m => m.id === t.id)).map(t => t.id) : [],
        targetKey: resolveTargetKey(),
        persistedModel: persistedCotModel(),
    }),
    /**
     * 收集当前页面上作用域内所有「未收录」的文本与属性字符串，
     * 以 JSON 输出到控制台 —— 上游更新后把新文案翻译进 dict.js 即可。
     */
    collect() {
        const missingText = new Set();
        const missingAttr = new Set();
        let roots;
        try {
            roots = document.querySelectorAll(FULL_SCOPE);
        } catch (e) {
            return { text: [], attr: [] };
        }
        for (const r of roots) {
            const tw = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
            let n;
            while ((n = tw.nextNode())) {
                const raw = n.nodeValue;
                if (!raw || !raw.trim()) continue;
                if (n.parentElement && SKIP_PARENT.has(n.parentElement.tagName)) continue;
                const k = norm(raw);
                if (k.length > 1 && !TEXT_DICT.has(k)) missingText.add(k);
            }
            const qs = r.querySelectorAll("[title],[aria-label],[placeholder]");
            for (const el of qs) {
                for (const a of TRANSATTRS) {
                    const v = el.getAttribute(a);
                    if (!v || !v.trim()) continue;
                    const k = norm(v);
                    if (!ATTR_DICT.has(k)) missingAttr.add(k);
                }
            }
        }
        const out = {
            text: Array.from(missingText).sort(),
            attr: Array.from(missingAttr).sort(),
        };
        console.log("%c[Megumin-Suite-ZH-Patch] 未收录字符串（%d 文本 / %d 属性）：", "color:#f59e0b;font-weight:bold", out.text.length, out.attr.length);
        console.log(JSON.stringify(out, null, 2));
        return out;
    },
};

console.info(
    `[Megumin-Suite-ZH-Patch] 中文补丁已加载 v${VERSION}（文本条目 ${TEXT_DICT.size}，属性条目 ${ATTR_DICT.size}）` +
    (COT_MODELS ? `；中文推理脚本已注入 ${COT_ZH.length} 条（V7–V10）。` : "；⚠ 未检测到 Megumin-Suite 注册表，CoT 中文功能未启用。") +
    `live 绑定 state=${MS_STATE ? "√" : "×"} save=${(MS_PROFILE && typeof MS_PROFILE.saveProfileToMemory === "function") ? "√" : "×"}` +
    "上游更新后若出现未翻译文案，在控制台运行 MEG_ZH.collect() 收集。"
);
