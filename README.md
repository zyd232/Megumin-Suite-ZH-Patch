# Megumin-Suite-ZH-Patch

给 SillyTavern 第三方扩展 **[Megumin Suite](https://github.com/Arif-salah/Megumin-Suite)** 做的中文补丁（界面翻译 + 中文推理脚本）。
以独立扩展的形式存在，**不改动 [Megumin-Suite](https://github.com/Arif-salah/Megumin-Suite) 原目录里的任何文件**，
上游插件更新后补丁照常工作，未收录的新文案自动回落英文（不会报错、不会乱码）。

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `manifest.json` | 扩展清单。`dependencies: ["third-party/Megumin-Suite"]` 保证只在 [Megumin Suite](https://github.com/Arif-salah/Megumin-Suite) 存在时加载；`loading_order: 110` 晚于上游 |
| `index.js` | 插件入口（manifest `js` 字段指向此处）：翻译引擎 + CoT 中文注入 |
| `src/dict.js` | 英文 → 中文字典（`TEXT_DICT` 文本节点、`ATTR_DICT` title/aria-label/placeholder） |
| `src/cot-zh.js` | V7/V8/V9/V10 中文推理脚本（`COT_ZH`，14 条） |
| `README.md` | 本文件 |
| `tools/` | 开发与验证脚本（字典校验、未收录词条提取、CoT 注入/保存修复验证），不参与插件运行 |
| `references/` | 构建材料（上游文案抽取批次、词条候选清单、V7–V9 条目 dump、去重前字典快照），不参与插件运行 |
| `.gitignore` | 将 `tools/`、`references/` 排除出仓库 |

仓库（即安装后实际落盘的内容）只包含最外层 + `src/`；`tools/`、`references/` 仅本地开发用，由 `.gitignore` 排除。

## 功能

1. **界面中文化**：设置弹窗、右侧追踪面板、在场角色栏、聊天气泡 `.meg-*` 区块、
   全局 toast 的精确词典翻译。
2. **中文推理脚本（CoT）**：向 V7/V8/V9/V10 引擎注入 14 条中文推理模板
   （Ukiyo / Shura / Fusion / 标准 / Lite / Director / Immersion / Hybrid 等），
   并在 V7+ 引擎的「推理语言」网格中注入「Mandarin (中文)」卡片。
   - 点击卡片走与上游语言卡片完全相同的写入路径（先更新内存 `localProfile.model`，
     再走扩展自己的 `saveProfileToMemory()` 落盘），「保存并关闭」不会把选择覆盖回英文；
   - 生成时按内存值查表，**下一条消息即生效**，无需刷新或切换聊天。

## 安装

1. 在 SillyTavern 中打开 `扩展程序` 面板，点击 `安装扩展程序` 按钮，输入
   `https://github.com/zyd232/Megumin-Suite-ZH-Patch`，
   根据 `Megumin-Suite` 插件的安装位置，选择 `给所有人安装` 或 `只给我安装`。
2. 安装完成后确认 **Megumin-Suite-ZH-Patch** 处于启用状态，然后刷新页面
   （扩展开关变更本身也会触发整页重载）。

启用即生效，无需其他配置。卸载 = 在 `扩展程序` 面板中删除该扩展，
或删除 `SillyTavern/scripts/extensions/third-party/Megumin-Suite-ZH-Patch/` 整个文件夹。

## 上游版本对照

本补丁的词典与中文推理脚本基于以下上游版本构建。上游更新后旧文案会自动
回落英文（不会报错），对照兼容性时以下表为准：

| 上游插件 | 基于版本 | 上游主页 | 备注 |
| --- | --- | --- | --- |
| [Megumin Suite](https://github.com/Arif-salah/Megumin-Suite)（`third-party/Megumin-Suite`） | v10.0 | [Arif-salah/Megumin-Suite](https://github.com/Arif-salah/Megumin-Suite) | 构建于 2026-10-02 |

`manifest.json` 的 `compatibleUpstream` 字段包含同样的标记，可程序化读取。

## 工作原理（为什么安全）

- **精确匹配**：只对「归一化（trim + 空白折叠）后与词典 key 完全相等」的字符串翻译。
  动态拼接的文案（含变量插值）不会被误伤。
- **作用域限定**：只处理 Megumin 设置弹窗、右侧追踪面板、在场角色栏、
  聊天气泡内 `.meg-*` 区块和全局 toast（toast 靠整句精确匹配保证不碰其他扩展的提示）。
- **不碰数据**：永不改写 `input`/`textarea` 的 `value`、`contenteditable` 内容，
  也永不翻译模型生成的内容（世界状态字段值、NPC 名字、独白等）。
- **无副作用**：翻译只改 DOM 展示文本；Megumin 的设置保存走 JS 对象（防抖写 localStorage），
  与 DOM 文本无关，翻译不影响任何功能。
- **CoT 注入**：只向上游共享 `models` 数组**追加**条目（同一 ES 模块实例，按 id 去重），
  上游 47 条原有条目零改动；上游未安装时 CoT 功能自动停用，词典翻译不受影响。

## 上游更新后如何保持中文化

1. 上游更新只覆盖 `Megumin-Suite/` 目录，本补丁文件夹不受影响。
2. 上游改过的旧文案：对应词典条目自动失效 → 该处回落英文，其余照常。
3. 上游新增的文案：不会翻译。收集方法——
   - 打开浏览器控制台，运行 `MEG_ZH.collect()`；
   - 它会把当前页面上作用域内所有未收录的英文字符串（文本 + 属性）
     以 JSON 打印出来；
   - 把需要的条目翻译成中文，按 `src/dict.js` 现有格式补入对应 Map；
   - 刷新页面（或运行 `MEG_ZH.refresh()`）。
4. 临时补词也可以直接在控制台用
   `MEG_ZH.addText("英文原文", "中文")` / `MEG_ZH.addAttr(...)`，立即生效但不持久。
5. CoT 中文功能诊断：控制台运行 `MEG_ZH.cotStatus()`
   （`ready`、`liveBindings`、`injected`、`targetKey`、`persistedModel`）。

## 已知取舍

- 含变量插值的模板句（例如 `NPC added to Bank: ${npcName}`）无法整体精确匹配，
  保持英文显示；这类串如需要可拆成片段词条（见 `src/dict.js` 中
  "Hide inline tracker blocks in chat" 描述的处理方式）。
- 词典按「逐字英文原文」建 key，上游若做大规模文案重写，需要重新 collect 一批条目。
- `PRESETS & COT`、`BLOCKS` 等品牌性短词与框架名（ComfyUI、Gemini 等）保留原文风格。
- 任何上游预设/引擎卡片的点击都会把对应引擎的语言重置回英文（上游自身行为）；
  如需中文，重新点击「Mandarin (中文)」卡片即可。
