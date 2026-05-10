# Cloudflare 聊天室-汉化增强版

这是一个基于 [Cloudflare Workers](https://workers.cloudflare.com/) 并使用 [Durable Objects](https://blog.cloudflare.com/introducing-workers-durable-objects) 实现的实时聊天应用演示，具有消息历史存储功能。该应用 100% 运行在 Cloudflare 的边缘网络上。

立即体验: https://edge-chat-demo.cloudflareworkers.com （体验版本为官方英文版，界面未汉化，无清空聊天功能）

这个演示的独特之处在于它处理了状态问题。在 Durable Objects 出现之前，Workers 是无状态的，状态必须存储在别处。状态不仅意味着存储，还意味着协调能力。在聊天室中，当一个用户发送消息时，应用必须通过其他用户已经建立的连接将消息路由给他们。这些连接就是状态，在无状态框架中协调它们非常困难甚至不可能。

## 工作原理

本聊天应用为每个聊天室使用一个 Durable Object。用户通过 WebSocket 连接到该对象。一个用户发送的消息会广播给其他所有用户。聊天历史也会存储在持久化存储中，但这仅用于历史记录。实时消息直接从发送者转发给其他用户，不经过存储层。

此外，本演示还使用 Durable Objects 实现了第二个功能：对特定IP的消息进行速率限制。每个IP被分配一个 Durable Object 来跟踪最近的请求频率，从而可以暂时阻止发送过多消息的用户——甚至可以跨多个聊天室进行限制。有趣的是，这些对象实际上并不存储任何持久状态，因为它们只关心最近的历史记录，而且偶尔重置速率限制器也无妨。因此，这些速率限制器对象是纯协调对象（无存储）的示例。

这个聊天应用只有几百行代码。部署配置也只有几行。然而，它可以无缝扩展到任意数量的聊天室，仅受 Cloudflare 可用资源的限制。当然，单个聊天室的可扩展性有其上限，因为每个对象都是单线程的。但这个上限远高于人类参与者所能达到的水平。

更多细节，请查看代码！代码中有详细的注释。

## 清空聊天(自制功能)

支持清空指定聊天室的聊天记录(相对于官方源代码新增功能。清空同时会清历史用户名，因为od空间的局限性，若需全部清空请删除并重建绑定的Durable Objects空间cloudflare-workers-chat_ChatRoom)

1.前置要求cf-项目worker-设置-环境变量(每次新部署，变量需要重新设置。如不设置默认ADMIN_SECRET_KEY="del")

ADMIN_SECRET_KEY="你设置的uuid"（例：c1d2e3f4-a5b6-7c8d-9e0f-1a2b3c4d5e6f）

ALL_ROOM_NAMES=""(可选，仅在批量清空指定房间聊天记录时需要设置。例：general,my-private-room,public-chat)
重要： 只有通过 idFromName 创建的、并且你在 ALL_ROOM_NAMES 中列出的房间才会被清空。如果你主要使用 newUniqueId() 创建的房间（即 ID 是 UUID 字符串），那么这个“清空所有房间”的功能将无法清空这些动态 ID 的房间，你需要使用 /api/admin/clear-room/<UUID> 接口清空它们。

2.清空特定房间的聊天记录：

URL 格式：https://你的项目域名.workers.dev/api/admin/clear-room/你的房间名称或ID?key=你设置的UUID密钥

示例：https://my-chat-app.workers.dev/api/admin/clear-room/general?key=c1d2e3f4-a5b6-7c8d-9e0f-1a2b3c4d5e6f

直接在浏览器中访问。

清空所有已知房间的聊天记录：

URL 格式：https://你的项目域名.workers.dev/api/admin/clear-all-rooms?key=你设置的UUID密钥

示例：https://my-chat-app.workers.dev/api/admin/clear-all-rooms?key=c1d2e3f4-a5b6-7c8d-9e0f-1a2b3c4d5e6f

直接在浏览器中访问。请确保 ALL_ROOM_NAMES 环境变量已正确设置。

清空特定 IP 的速率限制：

URL 格式：https://你的项目域名.workers.dev/api/admin/clear-rate-limit-ip?key=你设置的UUID密钥&ip=要清空的IP地址

示例：https://my-chat-app.workers.dev/api/admin/clear-rate-limit-ip?key=c1d2e3f4-a5b6-7c8d-9e0f-1a2b3c4d5e6f&ip=192.168.1.1

直接在浏览器中访问。


## 更新说明

此示例最初使用 [WebSocket API](https://developers.cloudflare.com/workers/runtime-apis/websockets/) 编写，后来[修改](https://github.com/cloudflare/workers-chat-demo/pull/32)为使用 [WebSocket 休眠 API](https://developers.cloudflare.com/durable-objects/api/websockets/#websocket-hibernation)，这是 Durable Objects 独有的功能。

在切换到休眠 API 之前，连接到聊天室的 WebSocket 会保持 Durable Object 固定在内存中，即使它们只是处于空闲状态。这意味着具有开放 WebSocket 连接的 Durable Object 只要保持连接就会产生持续时间费用。通过切换到 WebSocket 休眠 API，Workers 运行时可以从内存中驱逐非活动的 Durable Object 实例，但仍保留所有到 Durable Object 的 WebSocket 连接。当 WebSocket 再次变为活动状态时，运行时会重新创建 Durable Object 并将事件传递给相应的 WebSocket 事件处理程序。

切换到 WebSocket 休眠 API 将计费时间从 WebSocket 连接的整个生命周期缩短为 JavaScript 实际执行的时间。

## 了解更多

* [Durable Objects 介绍博客](https://blog.cloudflare.com/introducing-workers-durable-objects)
* [Durable Objects 文档](https://developers.cloudflare.com/workers/learning/using-durable-objects)
* [Durable Object WebSocket 文档](https://developers.cloudflare.com/durable-objects/reference/websockets/)

## 自行部署
本人部署经验：
cf-worker和page-创建worker-链接到github项目-worker项目名称cloudflare-workers-chat(如果要自定义名称请同步修改wrangler.toml里面的name=“ ”)
部署命令npx wrangler deploy，其他留空，部署即可
(可选)两个变量按需设置，建议ADMIN_SECRET_KEY修改为你的uuid，不然谁都可以清空聊天


这是官方教程：
如果尚未启用 Durable Objects，请访问 [Cloudflare 仪表板](https://dash.cloudflare.com/) 并导航至 "Workers"，然后选择 "Durable Objects"。

确保已安装 [Wrangler](https://developers.cloudflare.com/workers/cli-wrangler/install-update)（官方 Workers CLI）。建议使用 3.30.1 或更高版本来运行此示例。

安装后，运行 `wrangler login` 以[连接到您的 Cloudflare 账户](https://developers.cloudflare.com/workers/cli-wrangler/authentication)。

在账户上启用 Durable Objects 并安装和验证 Wrangler 后，可以通过运行以下命令首次部署应用：

    wrangler deploy

如果收到错误提示 "Cannot create binding for class [...] because it is not currently configured to implement durable objects"，则需要更新 Wrangler 版本。

此命令将应用部署到您的账户，名称为 `edge-chat-demo`。

## 依赖项

此演示代码除了 Cloudflare Workers（服务端 `chat.mjs`）和现代网页浏览器（客户端 `chat.html`）外，没有其他依赖项。部署代码需要 Wrangler。

## 卸载方法

修改 wrangler.toml 文件，移除 durable_objects 绑定并添加 deleted_classes 迁移。wrangler.toml 文件底部应如下所示：
```
[durable_objects]
bindings = [
]

#表示您希望 ChatRoom 和 RateLimiter 类可作为 Durable Objects 调用。
[[migrations]]
tag = "v1" # 每个条目应该是唯一的
new_classes = ["ChatRoom", "RateLimiter"]

[[migrations]]
tag = "v2"
deleted_classes = ["ChatRoom", "RateLimiter"]
```
然后运行 `wrangler deploy`，这将删除 Durable Objects 及其存储的所有数据。要移除 Worker，请访问 [dash.cloudflare.com](dash.cloudflare.com) 并导航至 Workers -> Overview -> edge-chat-demo -> Manage Service -> Delete (页面底部)
