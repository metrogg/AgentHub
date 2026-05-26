# AgentHub Android

AgentHub Android 是 AgentHub 的轻量移动端客户端。它的定位不是在手机上运行代码 Agent，而是让手机像 IM 客户端一样连接电脑端或网页端的 AgentHub：查看会话、发送指令、审批确认、预览产物，并实时接收 Agent 的流式输出。

移动端的代码执行、工作区文件访问、模型密钥、沙箱策略仍然保留在桌面端或服务端。手机端只负责交互与远程控制。

## 当前状态

这个目录已经包含第一版 Android 工程骨架：

- Kotlin + Jetpack Compose 应用壳。
- 手动输入服务端地址的连接页。
- 会话列表与聊天线程界面。
- 用于会话和消息的 REST 客户端。
- WebSocket 客户端，支持 `session:join`、`message:stream`、`message:completed` 和 typing 事件。
- 移动端技术路线文档：[docs/mobile-technical-route.md](docs/mobile-technical-route.md)。

后续计划包括扫码配对、设备 Token、推送通知、产物预览、审批卡片、电脑端流式输出共享等能力。

## 技术栈

- Android Gradle Plugin 8.13.2
- Kotlin 2.0.21
- Jetpack Compose + Material 3
- AndroidX Lifecycle ViewModel
- DataStore Preferences
- Kotlinx Serialization
- OkHttp REST / WebSocket
- JDK 17

应用信息：

- `applicationId`: `com.agenthub.mobile`
- `minSdk`: 26
- `targetSdk`: 35
- `versionName`: `0.1.0`

## 如何开发移动端

推荐用 Android Studio 开发：

1. 打开 Android Studio。
2. 选择 `Open`，打开 `F:\Learning\AgentHub\apps\Android`。
3. 等待 Gradle Sync 完成。
4. 确认项目 JDK 使用 17 或更新版本。
5. 选择 `app` 运行配置。
6. 连接 Android 模拟器或真机，点击 Run。

启动移动端前，需要先启动 AgentHub 服务端：

```bash
bun run dev:server
```

如果还需要同时看网页端，可以在项目根目录运行：

```bash
bun run dev
```

## 连接地址

Android 手机或模拟器需要连接到电脑上的 AgentHub 服务端，也就是默认的 `:8000` 端口。

Android 模拟器使用：

```text
http://10.0.2.2:8000
```

真机使用电脑的局域网 IP，例如：

```text
http://192.168.1.20:8000
```

真机调试时请确认：

- 手机和电脑在同一个 Wi-Fi 或局域网内。
- Windows 防火墙允许 `8000` 端口入站访问。
- 服务端监听地址允许局域网访问；如果只监听 `127.0.0.1`，真机无法访问。

## 扫码连接局域网

网页端和桌面端设置页提供“移动端扫码连接”入口：

1. 在电脑端打开 `设置 > 通用 > 移动端扫码连接`。
2. 点击 `生成二维码`。
3. 在 Android 客户端连接页点击 `扫码连接局域网`。
4. 扫描二维码后，手机会请求电脑端确认配对，并自动保存服务端地址和设备 Token。

二维码 2 分钟有效，用后即失效。当前二维码内容只用于局域网配对，不需要公网服务器。

## 调试建议

常用开发流程：

1. 先在电脑端启动服务端。
2. 在 Android Studio 运行 `app`。
3. 在连接页输入服务端地址。
4. 进入会话列表，选择会话。
5. 发送消息，观察 WebSocket 流式输出是否同步。

如果连接失败，优先检查：

- 服务端是否正在运行。
- 手机输入的地址是否是 `http://电脑IP:8000`。
- 电脑和手机是否在同一网络。
- 防火墙是否拦截。
- Android 模拟器是否误用了 `localhost`。模拟器访问宿主机必须用 `10.0.2.2`。

## Gradle 下载超时处理

如果 Android Studio 报错：

```text
Could not install Gradle distribution from 'https://services.gradle.org/distributions/gradle-9.0-milestone-1-bin.zip'
Reason: java.net.SocketTimeoutException: Connect timed out
```

说明 IDE 正在尝试下载一个不稳定的 Gradle milestone 版本，而且网络连接超时。本项目已在 `gradle/wrapper/gradle-wrapper.properties` 中固定为更适合当前 Android Gradle Plugin 的稳定版本：

```text
https://mirrors.cloud.tencent.com/gradle/gradle-8.13-bin.zip
```

处理方式：

1. 关闭 Android Studio 当前项目。
2. 重新打开 `F:\Learning\AgentHub\apps\Android`。
3. 打开 `Settings > Build, Execution, Deployment > Build Tools > Gradle`。
4. 确认 `Use Gradle from` 选择 `Gradle wrapper`。
5. 确认 `Gradle JDK` 选择 JDK 17 或 Android Studio 自带的 `jbr-17`。
6. 点击 `Sync Project with Gradle Files`。

如果仍然失败，可以删除本机坏掉的 Gradle 缓存后重试：

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.gradle\wrapper\dists\gradle-9.0-milestone-1-bin"
```

如果公司网络或代理仍然拦截下载，可以手动下载 `gradle-8.13-bin.zip`，放到本机任意目录，然后在 Android Studio 的 Gradle 设置里选择 `Local installation`，指向解压后的 Gradle 目录。

## 打包安装包

当前目录已固定 Gradle Wrapper 的分发版本，最稳妥的方式仍然是先用 Android Studio 完成 Sync，再通过 Android Studio 打包。

### 方式一：Android Studio 打 APK

1. 打开 `apps/Android`。
2. 点击菜单 `Build > Build Bundle(s) / APK(s) > Build APK(s)`。
3. 构建完成后，APK 通常在：

```text
F:\Learning\AgentHub\apps\Android\app\build\outputs\apk\debug\app-debug.apk
```

debug APK 可以直接安装到测试手机：

```bash
adb install -r apps/Android/app/build/outputs/apk/debug/app-debug.apk
```

### 方式二：Android Studio 打 Release 包

1. 点击 `Build > Generate Signed Bundle / APK...`。
2. 选择 `Android App Bundle` 或 `APK`。
3. 创建或选择签名证书。
4. 选择 `release`。
5. 完成构建。

产物路径通常为：

```text
F:\Learning\AgentHub\apps\Android\app\build\outputs\bundle\release\app-release.aab
F:\Learning\AgentHub\apps\Android\app\build\outputs\apk\release\app-release.apk
```

发布到应用商店一般使用 `.aab`；本地分发或内测可以使用 `.apk`。

### 方式三：命令行构建

如果本机安装了 Gradle，并且 Android SDK/JDK 环境变量配置正确，可以在 `apps/Android` 目录运行：

```bash
gradle :app:assembleDebug
gradle :app:assembleRelease
gradle :app:bundleRelease
```

建议后续补齐 `gradlew.bat` 和 `gradle-wrapper.jar`，这样可以统一使用：

```bash
.\gradlew.bat :app:assembleDebug
.\gradlew.bat :app:bundleRelease
```

## 安装到手机

debug 包安装：

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

release 包安装：

```bash
adb install -r app/build/outputs/apk/release/app-release.apk
```

如果手机提示无法安装，请检查：

- 是否开启了开发者选项和 USB 调试。
- 是否允许安装未知来源应用。
- 已安装版本是否签名不同；签名不同需要先卸载旧版本。

## 移动端架构方向

移动端建议继续采用“轻量 IM 客户端”架构：

- 会话列表：同步桌面端/网页端的 direct 和 group session。
- 聊天线程：展示历史消息、流式回复、Agent 状态。
- 命令输入：发送消息或命令到电脑端运行。
- 审批确认：展示高风险操作、文件变更、任务计划，用户在手机端确认。
- 产物预览：预览图片、文档、网页、日志、diff 等。
- 扫码连接：手机扫描桌面端二维码，自动写入服务端地址和设备 Token。

通信层建议：

- REST：加载会话、历史消息、设置、产物列表。
- WebSocket：接收流式输出、任务状态、typing、审批请求。
- Push：后续用于离线通知或后台提醒。

早期内网使用可以不依赖公网服务器，手机直接连电脑端服务即可。后续如果需要跨网络、离线通知、多设备同步，就需要增加中转服务器、账号体系、设备 Token 和端到端安全策略。

## 注意事项

当前工程是第一版移动端骨架，还没有完成扫码配对、推送通知和完整产物预览。开发时请优先保持手机端轻量，把复杂执行能力留在桌面端或服务端。
