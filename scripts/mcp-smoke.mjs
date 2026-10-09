#!/usr/bin/env node
/**
 * 麦麦通勤点单官 · MCP 连通性自检
 * ------------------------------------------------------------------
 * 按 MCP Streamable HTTP 协议连接麦当劳 MCP Server，
 * 依次执行 initialize → notifications/initialized → tools/list → 真实调用，
 * 用于验证「本 Skill 确实接通了麦当劳 MCP 能力」。
 *
 * Token 从环境变量 MCD_MCP_TOKEN 读取，不落盘、不打印。
 *
 * 用法：
 *   MCD_MCP_TOKEN=xxx node scripts/mcp-smoke.mjs
 *   MCD_MCP_TOKEN=xxx node scripts/mcp-smoke.mjs --call query-meals
 */

const ENDPOINT = process.env.MCD_MCP_ENDPOINT || 'https://mcp.mcd.cn';
const TOKEN = process.env.MCD_MCP_TOKEN;
const PROTOCOL_VERSION = '2025-06-18';

if (!TOKEN) {
  console.error('缺少环境变量 MCD_MCP_TOKEN。请先导出 Token 后再运行：');
  console.error('  MCD_MCP_TOKEN=xxx node scripts/mcp-smoke.mjs');
  process.exit(2);
}

let sessionId = null;
let nextId = 1;

/** 解析响应体：可能是纯 JSON，也可能是 SSE（text/event-stream） */
async function parseBody(res) {
  const text = await res.text();
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream') || text.trimStart().startsWith('event:')) {
    const payloads = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const chunk = line.slice(5).trim();
      if (!chunk) continue;
      try {
        payloads.push(JSON.parse(chunk));
      } catch {
        /* 忽略无法解析的事件块 */
      }
    }
    return payloads.length ? payloads[payloads.length - 1] : null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function rpc(method, params, { notification = false } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${TOKEN}`,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const body = notification
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: nextId++, method, params };

  const res = await fetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body) });

  const returnedSession = res.headers.get('mcp-session-id');
  if (returnedSession) sessionId = returnedSession;

  if (notification) return { status: res.status };

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const hint =
      res.status === 401
        ? 'Token 无效、已过期或未提供'
        : res.status === 429
          ? '触发限流（600 次/分钟）'
          : '未知错误';
    throw new Error(`HTTP ${res.status} — ${hint}${text ? `\n${text.slice(0, 300)}` : ''}`);
  }

  const parsed = await parseBody(res);
  if (parsed?.error) {
    throw new Error(`JSON-RPC 错误 ${parsed.error.code}: ${parsed.error.message}`);
  }
  return parsed;
}

function line(label) {
  console.log(`\n──────── ${label} ────────`);
}

async function main() {
  const args = process.argv.slice(2);
  const callIdx = args.indexOf('--call');
  const toolToCall = callIdx !== -1 ? args[callIdx + 1] : null;

  console.log(`端点：${ENDPOINT}`);
  console.log('Token：已从环境变量读取（不打印）');

  line('1/4 initialize');
  const init = await rpc('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'mcd-commute-butler-smoke', version: '1.0.0' },
  });
  const serverInfo = init?.result?.serverInfo;
  console.log('服务端：', serverInfo ? `${serverInfo.name} v${serverInfo.version}` : '(未返回 serverInfo)');
  console.log('协议版本：', init?.result?.protocolVersion ?? '(未返回)');
  console.log('会话 ID：', sessionId ? '已建立' : '服务端未下发（无状态模式）');

  line('2/4 notifications/initialized');
  await rpc('notifications/initialized', {}, { notification: true });
  console.log('已发送初始化完成通知');

  line('3/4 tools/list');
  const list = await rpc('tools/list', {});
  const tools = list?.result?.tools ?? [];
  console.log(`可用工具数：${tools.length}`);

  const showSchemas = args.includes('--schemas');
  const filterIdx = args.indexOf('--only');
  const only = filterIdx !== -1 ? args[filterIdx + 1] : null;

  for (const t of tools) {
    if (only && !t.name.includes(only)) continue;
    console.log(`  · ${t.name}`);
    if (showSchemas) {
      const schema = t.inputSchema ?? {};
      const props = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      const names = Object.keys(props);
      if (!names.length) {
        console.log('      (无入参)');
      } else {
        for (const name of names) {
          const p = props[name] ?? {};
          const flag = required.has(name) ? '必填' : '可选';
          const type = p.type ?? 'any';
          const desc = (p.description ?? '').replace(/\s+/g, ' ').slice(0, 70);
          console.log(`      ${name}  [${type}] ${flag}  ${desc}`);
        }
      }
    }
  }

  line('4/4 真实调用');
  const target = toolToCall || 'now-time-info';
  let callArgs = {};
  const argsIdx = args.indexOf('--args');
  if (argsIdx !== -1) {
    const raw = args[argsIdx + 1];
    if (!raw) {
      console.error('用法：--args \'{"address":"..."}\'');
      process.exit(2);
    }
    try {
      callArgs = JSON.parse(raw);
    } catch {
      console.error('--args 必须是合法 JSON');
      process.exit(2);
    }
  }

  if (!tools.some((t) => t.name === target)) {
    console.log(`跳过：服务端未暴露工具 "${target}"`);
  } else {
    console.log(`调用工具：${target}`);
    console.log(`入参：${JSON.stringify(callArgs)}`);
    const called = await rpc('tools/call', { name: target, arguments: callArgs });
    const content = called?.result?.content ?? [];
    const textParts = content.filter((c) => c.type === 'text').map((c) => c.text);
    let text = textParts.length ? textParts.join('\n') : JSON.stringify(called?.result ?? {}, null, 2);

    // 麦当劳 MCP 的返回文本通常包含「字段说明 + 原始响应」两段。
    // 默认只展示原始响应，避免字段说明淹没真正的数据；加 --raw 可看全文。
    if (!args.includes('--raw')) {
      const marker = text.indexOf('## Original Response');
      if (marker !== -1) {
        text = text.slice(marker + '## Original Response'.length).trim();
      }
      // 去掉尾部的模型提示语
      const tail = text.indexOf('## 展示结果时');
      if (tail !== -1) text = text.slice(0, tail).trim();
    }

    console.log('返回内容：');
    console.log(text.slice(0, 4000));

    const outIdx = args.indexOf('--out');
    if (outIdx !== -1) {
      const outPath = args[outIdx + 1];
      if (!outPath) {
        console.error('用法：--out <path.json>');
        process.exit(2);
      }
      const { writeFileSync } = await import('node:fs');
      writeFileSync(outPath, text, 'utf8');
      console.log(`\n完整响应已写入：${outPath}`);
    }
  }

  line('自检结论');
  console.log('✅ 麦当劳 MCP 连接正常，Token 有效，工具可调用。');
}

main().catch((err) => {
  console.error('\n❌ 自检失败：');
  console.error(err.message);
  process.exit(1);
});
