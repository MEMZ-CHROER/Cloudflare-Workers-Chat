// 这是使用 Durable Objects 构建的边缘聊天演示 Worker！

// ===============================
// 模块化介绍
// ===============================
//
// 如果您熟悉 Workers 平台，首先会注意到这个 Worker 的编写方式与您之前见过的不同。
// 它甚至使用了不同的文件扩展名。`mjs` 扩展名表示这是一个 ES 模块，这意味着它可以
// 使用导入和导出。与其他 Worker 不同，这段代码不使用 `addEventListener("fetch", handler)`
// 来注册其主要的 HTTP 处理器；相反，它直接导出一个处理器，如下所示。
//
// 这是我们预期未来会广泛采用的新写法。我们喜欢这种语法，因为它是可组合的：
// 您可以将两个这样编写的 Worker 合并为一个，通过导入它们的处理器并按需调用。
//
// 使用 Durable Objects 时必须使用这种新语法，因为您的 Durable Objects 是通过类实现的，
// 而这些类需要被导出。目前您需要加入 Durable Objects beta 才能使用此语法。
//
// 要查看基于模块的 Worker 配置示例，请查看 wrangler.toml 文件或我们的 Durable Object 模板：
//   * https://github.com/cloudflare/durable-objects-template
//   * https://github.com/cloudflare/durable-objects-rollup-esm
//   * https://github.com/cloudflare/durable-objects-webpack-commonjs

// ===============================
// 所需环境配置
// ===============================
//
// 部署此 Worker 时需要配置两个环境绑定：
// * rooms: 映射到 ChatRoom 类的 Durable Object 命名空间绑定
// * limiters: 映射到 RateLimiter 类的 Durable Object 命名空间绑定
//
// 在模块化语法中，绑定通过"环境对象"传递，而不是作为全局变量。
// 这是为了更好的代码组合性。

// =======================================================================================
// 常规 Worker 部分...
//
// 这部分代码实现了一个普通的 Worker，接收来自外部客户端的 HTTP 请求。这部分是无状态的。

// 我们通过导入将 HTML 内容作为 ArrayBuffer 加载，这样可以直接提供静态资源而无需额外存储
import HTML from "./chat.html";

// `handleErrors()` 是一个实用函数，用于包装 HTTP 请求处理器并在出错时向客户端返回错误信息
async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get("Upgrade") == "websocket") {
      // 对于 WebSocket 请求，我们通过 WebSocket 帧返回错误信息
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({error: err.stack}));
      pair[1].close(1011, "会话设置期间未捕获的异常");
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return new Response(err.stack, {status: 500});
    }
  }
}

// 使用 `export default` 导出主要的 fetch 事件处理器
export default {
  async fetch(request, env) {
    return await handleErrors(request, async () => {
      // 解析 URL 并路由请求
      let url = new URL(request.url);
      let path = url.pathname.slice(1).split('/');

      if (!path[0]) {
        // 在根路径提供 HTML
        return new Response(HTML, {headers: {"Content-Type": "text/html;charset=UTF-8"}});
      }

      switch (path[0]) {
        case "api":
          // 处理 `/api/...` 请求
          return handleApiRequest(path.slice(1), request, env);

        default:
          return new Response("未找到", {status: 404});
      }
    });
  }
}

// 处理 API 请求
async function handleApiRequest(path, request, env) {
  switch (path[0]) {
    case "room": {
      // 处理 `/api/room/...` 请求
      if (!path[1]) {
        if (request.method == "POST") {
          // POST 到 /api/room 创建私有房间
          let id = env.rooms.newUniqueId();
          return new Response(id.toString(), {headers: {"Access-Control-Allow-Origin": "*"}});
        } else {
          return new Response("方法不允许", {status: 405});
        }
      }

      // 处理特定房间的请求
      let name = path[1];
      let id;
      if (name.match(/^[0-9a-f]{64}$/)) {
        // 64位十六进制 ID
        id = env.rooms.idFromString(name);
      } else if (name.length <= 32) {
        // 字符串房间名
        id = env.rooms.idFromName(name);
      } else {
        return new Response("名称过长", {status: 404});
      }

      // 获取 Durable Object 存根
      let roomObject = env.rooms.get(id);

      // 构造新的 URL 并转发请求
      let newUrl = new URL(request.url);
      newUrl.pathname = "/" + path.slice(2).join("/");

      return roomObject.fetch(newUrl, request);
    }

    default:
      return new Response("未找到", {status: 404});
  }
}

// =======================================================================================
// ChatRoom Durable Object 类

// ChatRoom 实现了一个协调单个聊天室的 Durable Object
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;  // 提供对持久存储的访问
    this.env = env;  // 环境绑定
    this.sessions = new Map();  // 跟踪客户端 WebSocket 的元数据

    // 从休眠状态恢复时重新建立现有 WebSocket
    this.state.getWebSockets().forEach((webSocket) => {
      let meta = webSocket.deserializeAttachment();
      let limiterId = this.env.limiters.idFromString(meta.limiterId);
      let limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        err => webSocket.close(1011, err.stack));

      let blockedMessages = [];
      this.sessions.set(webSocket, { ...meta, limiter, blockedMessages });
    });

    this.lastTimestamp = 0;  // 最后看到的消息时间戳
  }

  // 处理发送到此对象的 HTTP 请求
  async fetch(request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);

      switch (url.pathname) {
        case "/websocket": {
          // 处理 WebSocket 连接请求
          if (request.headers.get("Upgrade") != "websocket") {
            return new Response("需要 WebSocket", {status: 400});
          }

          let ip = request.headers.get("CF-Connecting-IP");
          let pair = new WebSocketPair();
          await this.handleSession(pair[1], ip);
          return new Response(null, { status: 101, webSocket: pair[0] });
        }

        default:
          return new Response("未找到", {status: 404});
      }
    });
  }

  // 实现基于 WebSocket 的聊天协议
  async handleSession(webSocket, ip) {
    this.state.acceptWebSocket(webSocket);

    // 设置速率限制器
    let limiterId = this.env.limiters.idFromName(ip);
    let limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        err => webSocket.close(1011, err.stack));

    // 创建会话并添加到会话映射
    let session = { limiterId, limiter, blockedMessages: [] };
    webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), limiterId: limiterId.toString() });
    this.sessions.set(webSocket, session);

    // 为所有在线用户排队"加入"消息
    for (let otherSession of this.sessions.values()) {
      if (otherSession.name) {
        session.blockedMessages.push(JSON.stringify({joined: otherSession.name}));
      }
    }

    // 加载最近的100条聊天记录
    let storage = await this.storage.list({reverse: true, limit: 100});
    let backlog = [...storage.values()];
    backlog.reverse();
    backlog.forEach(value => {
      session.blockedMessages.push(value);
    });
  }

  // 处理 WebSocket 消息
  async webSocketMessage(webSocket, msg) {
    try {
      let session = this.sessions.get(webSocket);
      if (session.quit) {
        webSocket.close(1011, "WebSocket 已损坏");
        return;
      }

      // 检查速率限制
      if (!session.limiter.checkLimit()) {
        webSocket.send(JSON.stringify({
          error: "您的IP受到速率限制，请稍后再试"
        }));
        return;
      }

      let data = JSON.parse(msg);

      if (!session.name) {
        // 第一条消息包含用户名
        session.name = "" + (data.name || "匿名");
        webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), name: session.name });

        if (session.name.length > 32) {
          webSocket.send(JSON.stringify({error: "名称过长"}));
          webSocket.close(1009, "名称过长");
          return;
        }

        // 发送所有排队消息
        session.blockedMessages.forEach(queued => {
          webSocket.send(queued);
        });
        delete session.blockedMessages;

        // 广播用户加入消息
        this.broadcast({joined: session.name});

        webSocket.send(JSON.stringify({ready: true}));
        return;
      }

      // 构造净化后的消息
      data = { name: session.name, message: "" + data.message };

      if (data.message.length > 256) {
        webSocket.send(JSON.stringify({error: "消息过长"}));
        return;
      }

      // 添加时间戳
      data.timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
      this.lastTimestamp = data.timestamp;

      // 广播消息
      let dataStr = JSON.stringify(data);
      this.broadcast(dataStr);

      // 保存消息
      let key = new Date(data.timestamp).toISOString();
      await this.storage.put(key, dataStr);
    } catch (err) {
      webSocket.send(JSON.stringify({error: err.stack}));
    }
  }

  // 处理 WebSocket 关闭和错误
  async closeOrErrorHandler(webSocket) {
    let session = this.sessions.get(webSocket) || {};
    session.quit = true;
    this.sessions.delete(webSocket);
    if (session.name) {
      this.broadcast({quit: session.name});
    }
  }

  async webSocketClose(webSocket, code, reason, wasClean) {
    this.closeOrErrorHandler(webSocket)
  }

  async webSocketError(webSocket, error) {
    this.closeOrErrorHandler(webSocket)
  }

  // 广播消息给所有客户端
  broadcast(message) {
    if (typeof message !== "string") {
      message = JSON.stringify(message);
    }

    let quitters = [];
    this.sessions.forEach((session, webSocket) => {
      if (session.name) {
        try {
          webSocket.send(message);
        } catch (err) {
          session.quit = true;
          quitters.push(session);
          this.sessions.delete(webSocket);
        }
      } else {
        session.blockedMessages.push(message);
      }
    });

    quitters.forEach(quitter => {
      if (quitter.name) {
        this.broadcast({quit: quitter.name});
      }
    });
  }
}

// =======================================================================================
// RateLimiter Durable Object 类

// RateLimiter 实现了一个跟踪消息频率并决定何时丢弃消息的 Durable Object
export class RateLimiter {
  constructor(state, env) {
    // 此IP下次允许发送消息的时间戳
    this.nextAllowedTime = 0;
  }

  // 协议：POST 表示IP执行了操作，GET 只读取当前限制
  async fetch(request) {
    return await handleErrors(request, async () => {
      let now = Date.now() / 1000;
      this.nextAllowedTime = Math.max(now, this.nextAllowedTime);

      if (request.method == "POST") {
        // 每5秒允许一个操作
        this.nextAllowedTime += 5;
      }

      // 返回客户端需要等待的秒数
      let cooldown = Math.max(0, this.nextAllowedTime - now - 20);
      return new Response(cooldown);
    })
  }
}

// RateLimiterClient 在调用方实现速率限制逻辑
class RateLimiterClient {
  constructor(getLimiterStub, reportError) {
    this.getLimiterStub = getLimiterStub;
    this.reportError = reportError;
    this.limiter = getLimiterStub();
    this.inCooldown = false;
  }

  // 检查是否应该接受消息
  checkLimit() {
    if (this.inCooldown) {
      return false;
    }
    this.inCooldown = true;
    this.callLimiter();
    return true;
  }

  // 内部方法，与速率限制器通信
  async callLimiter() {
    try {
      let response;
      try {
        response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
      } catch (err) {
        // 获取新的限制器存根并重试
        this.limiter = this.getLimiterStub();
        response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
      }

      let cooldown = +(await response.text());
      await new Promise(resolve => setTimeout(resolve, cooldown * 1000));
      this.inCooldown = false;
    } catch (err) {
      this.reportError(err);
    }
  }
}
