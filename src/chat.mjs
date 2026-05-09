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
// 新增：
// * ADMIN_SECRET_KEY: 用于清空聊天记录和速率限制的密钥（在 Cloudflare Worker 设置中配置）
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

// 定义环境接口，包含 Durable Object 绑定和自定义变量
// 这有助于 TypeScript 检查，但对于纯 JavaScript 来说不是必需的
/**
 * @typedef {Object} Env
 * @property {DurableObjectNamespace} rooms
 * @property {DurableObjectNamespace} limiters
 * @property {string} ADMIN_SECRET_KEY
 */

// 使用 `export default` 导出主要的 fetch 事件处理器
export default {
  /**
   * @param {Request} request
   * @param {Env} env
   */
  async fetch(request, env) {
    return await handleErrors(request, async () => {
      // 解析 URL 并路由请求
      let url = new URL(request.url);
      let path = url.pathname.slice(1).split('/');

      if (!path[0]) {
        // 在根路径提供 HTML
        return new Response(HTML, {headers: {"Content-Type": "text/html;charset=UTF-C8"}});
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

/**
 * @param {string[]} path
 * @param {Request} request
 * @param {Env} env
 */
async function handleApiRequest(path, request, env) {
  if (path[0] === "room") {
    // 处理房间相关的 API 请求
    if (path.length === 1) {
      // 创建新的私人房间，返回 Durable Object ID
      return handleNewPrivateRoom(request, env);
    } else if (path.length === 2) {
      if (path[1] === "websocket") {
        // 这里的路径应该由 /api/room/<name>/websocket 处理，所以这里应该是 404
        return new Response("Not Found", {status: 404});
      } else if (path[1] === "clear" && request.method === "POST") {
        // 清空房间聊天记录和速率限制 (例如: /api/room/some-room/clear)
        let roomName = path[1];
        let id = env.rooms.idFromName(roomName);
        let roomObject = env.rooms.get(id);
        
        let { secretKey } = await request.json(); // 假设 secretKey 通过 body 传递
        if (secretKey !== env.ADMIN_SECRET_KEY) {
          return new Response("Unauthorized", { status: 403 });
        }
        
        // 调用 Durable Object 的 /clear 内部方法
        let response = await roomObject.fetch(new URL("https://fake-host/clear"), {
          method: "POST",
          headers: {
            "X-Admin-Secret-Key": secretKey, // 传递 secretKey 给 DO
          }
        });
        return response;
      }
    } else if (path.length === 3 && path[2] === "websocket") {
      // 这是一个WebSocket请求，连接到某个 Durable Object 实例
      // 路径: /api/room/<name>/websocket
      let roomName = path[1];
      let id = env.rooms.idFromName(roomName);
      let roomObject = env.rooms.get(id);
      return roomObject.fetch(request.url, request);
    } else if (path.length === 4 && path[2] === "kick" && request.method === "POST") {
      // 新增：处理踢人请求
      // 路径: /api/room/<roomName>/kick/<memberName>
      let roomName = path[1];
      let memberName = path[3]; // 从路径中获取要踢出的成员名称
      
      let id = env.rooms.idFromName(roomName);
      let roomObject = env.rooms.get(id);

      // 获取 secretKey
      let requestBody;
      try {
        requestBody = await request.json(); // 假设 secretKey 通过 body 传递
      } catch (e) {
        return new Response("Invalid JSON in request body", { status: 400 });
      }
      let secretKey = requestBody.secretKey;

      if (!secretKey || secretKey !== env.ADMIN_SECRET_KEY) {
        return new Response("Unauthorized", { status: 403 });
      }

      // 调用 Durable Object 的 kick 方法
      let response = await roomObject.fetch(`https://fake-host/kick?memberName=${encodeURIComponent(memberName)}`, {
        method: "POST", // 使用POST方法
        headers: {
          "X-Admin-Secret-Key": secretKey, // 将 secretKey 传递给 Durable Object 进行验证
        }
      });

      return response;
    }
  } else if (path[0] === "user") {
    // 处理用户相关的 API 请求 (例如: /api/user/rate-limit)
    return handleRateLimit(request, env);
  }

  return new Response("未找到", {status: 404});
}

/**
 * @param {Request} request
 * @param {Env} env
 */
async function handleNewPrivateRoom(request, env) {
  let id = env.rooms.newUniqueId();
  return new Response(id.toString(), {headers: {"Content-Type": "text/plain"}});
}

/**
 * @param {Request} request
 * @param {Env} env
 */
async function handleRateLimit(request, env) {
  let ip = request.headers.get("CF-Connecting-IP");
  let id = env.limiters.idFromName(ip);
  let limiter = env.limiters.get(id);
  return limiter.fetch(request.url, request);
}

// =======================================================================================
// Durable Object 部分...
//
// 这部分代码定义了 Durable Object 类。该对象是单例的，每个 ID 只有一个实例。
// Durable Object 的所有请求都被序列化处理。

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

// `ChatRoom` Durable Object 代表一个单独的聊天室。
export class ChatRoom {
  /**
   * @param {DurableObjectState} state
   * @param {Env} env
   */
  constructor(state, env) {
    this.state = state;
    this.env = env;

    // `sessions` 是当前连接到此 Durable Object 的所有 WebSocket 会话的列表。
    // 我们存储一个带有用户名的 {webSocket, quit, name} 对象。
    this.sessions = [];

    // `blockedUsers` 存储被禁止发送消息的用户。
    // 我们将用户名映射到一个到期时间。
    this.blockedUsers = {};

    this.state.blockConcurrencyWhile(async () => {
      // 在 DO 启动时，如果存储中有会话信息，可以恢复，
      // 但对于 WebSocket 连接，它们会在 DO 重启时断开，
      // 所以这里不需要从存储中恢复活动会话。
    });
  }

  // `fetch` 是 Durable Object 的主要入口点。
  // 它处理来自 Worker 的所有传入 HTTP 请求。
  /**
   * @param {Request} request
   */
  async fetch(request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);

      if (url.pathname === "/websocket") {
        // 创建一个新的 WebSocketPair。注意：这两个 WebSocket 连接
        // 都可以在 Workers 的 contexts 中独立使用。
        let pair = new WebSocketPair();

        // 接受传入的连接，并将其传递给我们的 `webSocket` 处理程序。
        await this.handleWebSocket(pair[1]);

        // 返回配对的另一半，作为客户端的 HTTP 响应。
        return new Response(null, { status: 101, webSocket: pair[0] });
      } else if (url.pathname === "/clear" && request.method === "POST") {
        // 处理清空聊天记录的请求
        const adminSecretKey = request.headers.get("X-Admin-Secret-Key");
        if (adminSecretKey !== this.env.ADMIN_SECRET_KEY) {
          return new Response("Unauthorized", { status: 403 });
        }

        await this.state.storage.deleteAll();
        // 清空内存中的会话列表，这将导致所有连接断开并重新连接
        this.sessions.forEach(session => {
          try {
            session.webSocket.close(1000, "管理员已清空聊天记录。");
          } catch (e) { /* ignore */ }
        });
        this.sessions = []; // 清空活动会话
        this.blockedUsers = {}; // 清空黑名单
        this.broadcast({ info: "管理员已清空聊天记录并重置房间。" });
        return new Response("Room cleared.", { status: 200 });
      } else if (url.pathname === "/kick" && request.method === "POST") {
        // 处理踢人请求
        const adminSecretKey = request.headers.get("X-Admin-Secret-Key");
        if (adminSecretKey !== this.env.ADMIN_SECRET_KEY) {
          return new Response("Unauthorized", { status: 403 });
        }

        const memberName = url.searchParams.get("memberName");
        if (!memberName) {
          return new Response("Missing memberName parameter.", { status: 400 });
        }

        const success = await this.kickMember(memberName);
        if (success) {
          return new Response(`Member "${memberName}" kicked.`, { status: 200 });
        } else {
          return new Response(`Member "${memberName}" not found or already disconnected.`, { status: 404 });
        }

      } else {
        return new Response("未找到", { status: 404 });
      }
    });
  }

  /**
   * @param {WebSocket} webSocket
   */
  async handleWebSocket(webSocket) {
    webSocket.accept();

    let session = { webSocket, quit: new Promise(resolve => webSocket.addEventListener("close", resolve)) };
    this.sessions.push(session);

    // 等待客户端发送其用户名。
    let name = await new Promise(resolve => {
      // 给客户端一个超时，如果他们不发送名称
      let timeout = setTimeout(() => {
        webSocket.close(1000, "未在规定时间内发送用户名");
        resolve(null); // Resolve with null to indicate timeout/error
      }, 5000); // 5秒超时
      
      // === 关键修复：添加 { once: true } ===
      webSocket.addEventListener("message", msg => {
        try {
          let data = JSON.parse(msg.data);
          if (data.name) {
            clearTimeout(timeout); // 清除超时
            resolve(String(data.name).slice(0, 32));
          } else {
            webSocket.send(JSON.stringify({error: "需要发送 `name` 消息作为第一个消息。"}));
          }
        } catch (err) {
          webSocket.send(JSON.stringify({error: "解析 JSON 失败: " + err}));
        }
      }, { once: true }); // <--- 这个监听器只触发一次，用于获取用户名。
    });

    if (name === null) {
      // 客户端未在规定时间内发送名称，会话已关闭
      this.sessions = this.sessions.filter(s => s !== session);
      return;
    }

    // 存储用户名。
    session.name = name;

    // 向所有连接广播新用户已加入的消息。
    this.broadcast({ joined: name });

    // 从存储中获取最近的 100 条消息并发送给新连接的用户。
    let storage = await this.state.storage.list({limit: 100, reverse: true});
    let messages = Array.from(storage.values()).reverse();
    for (let msg of messages) {
      webSocket.send(JSON.stringify(msg));
    }

    // 通过发送 "ready" 消息告诉客户端我们已发送所有历史消息。
    session.webSocket.send(JSON.stringify({ready: true}));

    // === 核心聊天消息处理逻辑：此监听器处理所有后续的聊天消息 ===
    webSocket.addEventListener("message", async msg => {
      try {
        let data = JSON.parse(msg.data);
        if (data.message) {
          // 检查是否在黑名单中
          let expires = this.blockedUsers[session.name]; // 使用 session.name
          if (expires && expires > Date.now()) {
            webSocket.send(JSON.stringify({error: "你已被禁止发送消息，请稍后再试。"}));
            return;
          }

          // 收到消息，广播给所有连接。
          let chatMessage = { name: session.name, message: String(data.message).slice(0, 256), timestamp: Date.now() }; // 使用 session.name
          this.broadcast(chatMessage);

          // 将消息持久化到 Durable Object 的存储中。
          await this.state.storage.put(String(chatMessage.timestamp), chatMessage);
        }
      } catch (err) {
        webSocket.send(JSON.stringify({error: "解析 JSON 失败: " + err}));
      }
    });
    // ===================================

    // 等待此会话关闭。
    await session.quit;

    this.sessions = this.sessions.filter(s => s !== session);
    this.broadcast({ quit: name });
  }

  // `broadcast()` 向所有连接的 WebSocket 会话发送消息。
  /**
   * @param {Object} message
   */
  broadcast(message) {
    let cleanedSessions = [];
    for (let session of this.sessions) {
      try {
        session.webSocket.send(JSON.stringify(message));
        cleanedSessions.push(session);
      } catch (err) {
        // 忽略连接错误，移除坏掉的会话。
        console.error("Error broadcasting to session:", err);
      }
    }
    this.sessions = cleanedSessions;
  }

  // `kickMember` 方法，用于踢出指定成员
  /**
   * @param {string} memberName - 要踢出的成员的名称
   * @returns {boolean} 如果成功踢出成员，则返回 true；否则返回 false。
   */
  async kickMember(memberName) {
    let kicked = false;

    this.sessions = this.sessions.filter(session => {
      if (session.name === memberName) {
        try {
          session.webSocket.send(JSON.stringify({ error: "你已被管理员踢出聊天室。" }));
          session.webSocket.close(1000, "你已被踢出");
          kicked = true;
          this.broadcast({ info: `管理员已将 ${memberName} 踢出聊天室。` });
        } catch (err) {
          console.error(`Error closing WebSocket for kicked member ${memberName}:`, err);
        }
        return false; // 从会话列表中移除
      }
      return true; // 保留其他会话
    });

    if (kicked) {
      console.log(`Member ${memberName} kicked from room.`);
    } else {
      console.log(`Member ${memberName} not found in room or already disconnected.`);
    }
    return kicked;
  }

  /**
   * 此方法未在当前 Worker 逻辑中使用，仅为示例
   * @param {string} ip
   */
  async blockIp(ip) {
    console.log(`IP ${ip} blocked.`);
  }
}

// `RateLimiter` Durable Object 跟踪单个 IP 地址的请求速率。
export class RateLimiter {
  /**
   * @param {DurableObjectState} state
   */
  constructor(state) {
    this.state = state;
    this.lastTimestamp = 0;
    this.count = 0;
  }

  // `fetch` 是 Durable Object 的主要入口点。
  // 它处理来自 Worker 的所有传入 HTTP 请求。
  /**
   * @param {Request} request
   */
  async fetch(request) {
    let url = new URL(request.url);

    // 我们每秒允许 3 个请求。如果超过，则返回 429。
    let now = Date.now();
    if (now - this.lastTimestamp > SECOND) {
      this.count = 0;
      this.lastTimestamp = now;
    }

    this.count++;
    if (this.count > 3) {
      return new Response("速率限制", {status: 429});
    }

    return new Response("你好，我是速率限制器！", {status: 200});
  }
}
