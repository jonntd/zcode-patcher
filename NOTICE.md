# NOTICE / 第三方声明

本仓库除自身代码外，包含或改编了以下第三方作品。按其许可要求在此保留归属与许可声明。

## zcode-modelhub-patch（MIT）

- 项目：<https://github.com/CSSZYF/zcode-modelhub-patch>
- 版权：Copyright (c) 2026 CSSZYF
- 许可：MIT License
- 本项目中的使用范围：
  - `scripts/modelhub_payload.json` —— 迁移自该项目的注入载荷（patch-core.js v1.2.1）
    中的字符串常量。原项目已以 MIT 授权发布，这些常量在本仓库中按 MIT 条款使用。
  - `scripts/zcode-patcher.js` 中 `--modelhub` 补丁的定位锚点与注入逻辑，参考该项目
    的实现后重新编写。

MIT License 全文：

```
MIT License

Copyright (c) 2026 CSSZYF

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## WB Enhance Prompt 提示词模板

- 来源：社区分享的 “WB Enhance Prompt 1.5.5”（原始出处与许可未标明）
- 本项目中的使用范围：`scripts/zcode-enhance.js` 内置的「简洁模式 / 创意模式」提示词
  模板保留了其原文措辞，并按本项目的交互做了包装。
- 该模板的著作权归原作者；本项目按社区的既有使用方式引用，未主张其权利。如原作者
  认为引用不当或希望补充署名/许可信息，请通过 Issues 联系，我们会配合更正或移除。

## 关于 ZCode 客户端

ZCode 客户端本身是**闭源专有软件**，其版权归其权利人所有，**不在**本仓库的授权范围内。
本仓库不收录其完整程序文件；仅在补丁脚本中保留定位修改点所必需的**最小片段**
（字符串锚点），且这些片段随本工具一同分发。其权利与许可与本仓库的 AGPL-3.0
许可**相互独立**：本仓库的 AGPL-3.0 仅适用于本项目自身编写的代码，不适用于
ZCode 客户端或其任何组成部分。

如权利人认为上述引用不当，请通过 Issues 联系，我们将立即配合移除。
