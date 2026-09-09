# 第三方依赖声明（Third-Party Notices）

本项目的源代码以 [MIT License](LICENSE) 授权，**MIT 仅覆盖本项目自有代码**（`src/`、`dist/`、`docs/`、`scripts/`），不覆盖其运行所依赖的第三方包。

本项目**仅通过 npm 依赖声明引用**第三方包，不携带、不捆绑、不修改任何第三方代码：`dist/` 构建产物只包含本项目自有代码的编译结果，使用者通过 `npm install` 自行从 npm registry 获取各依赖并接受其相应许可。

## 直接依赖及许可

| 依赖 | 许可 | 说明 |
| --- | --- | --- |
| `@sap/hana-client` | **SAP Developer License Agreement 3.2**（非开源，见包内 `developer-license-3_2.txt`） | SAP HANA 官方 Node.js 驱动。许可授予使用者开发自有应用的权利，**禁止向第三方提供/转让 SAP Tools 本体**；本仓库不携带此包，由使用者自行安装并接受该许可 |
| `fast-xml-parser` | MIT | 设计时 XML 解析 |
| `pino` | MIT | 日志 |
| `zod` | MIT | 配置/工具参数 schema 校验 |
| `@modelcontextprotocol/core` / `node` / `server` | MIT | MCP 协议 SDK |
| `@types/node` | MIT | Node 类型定义 |
| `tsx` | MIT | 开发期 TS 运行器（devDependencies） |
| `typescript` | Apache-2.0 | 编译器（devDependencies） |

各传递依赖的许可以其自身包内声明为准，可用 `npm ls` / `license-checker` 自行核查。

## @sap/hana-client 使用要点（SAP Developer License 3.2）

- 该许可授权使用者基于 SAP 提供的 API/Tools 开发自有应用（Customer Application），自有应用的知识产权归使用者所有——因此本项目自有代码可以 MIT 授权。
- **再分发边界**：请勿将 `node_modules`（含 `@sap/hana-client` 及其原生二进制）随本项目的分发包一起提供（如整包 zip、打包 `node_modules` 的 Docker 镜像分发给他人、MCPB 捆绑包等）——那会构成对 SAP Tools 的再分发，触碰该许可 §2(a) 的限制。正确的做法是让每个使用者自行 `npm install`。
- 该许可 §3 禁止将 SAP Materials 用于 AI 模型训练；本工具属运行期调用（inference），不在其列。
- 该许可为可终止许可（§11），SAP 终止后使用者须销毁所持 SAP Materials 拷贝。
