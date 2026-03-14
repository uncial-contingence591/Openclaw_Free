#!/usr/bin/env node
const http = require('http');
const { URL } = require('url');

const PORT = process.env.PORT || 8765;
const PENDING_REQUESTS = new Map();
const REQUEST_QUEUE = [];

function ts() { return new Date().toISOString(); }
function log(tag, ...args) { console.log(`[${ts()}] [${tag}]`, ...args); }

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...extraHeaders
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  log('REQ', req.method, url.pathname);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/v1/models')) {
    log('HEALTH', 'Returning model list');
    return sendJson(res, 200, {
      object: "list",
      data: [{ id: "gemini-2.0-flash", object: "model", owned_by: "gemini" }]
    });
  }

  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions' || url.pathname === '/gemini')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const isStreaming = data.stream === true;
        log('QUEUE', `New ${url.pathname} request — streaming=${isStreaming}`);

        log('DUMP', 'Raw body:', JSON.stringify(data, null, 2));

        let prompt = "";
        const tools = data.tools || [];   

        if (data.messages && data.messages.length) {
          const getText = m => {
            if (m.role === 'tool') {

              return `[Tool result for call_id=${m.tool_call_id}]\n${m.content || ''}`;
            }
            if (Array.isArray(m.content)) {
              return m.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
            }

            if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
              const calls = m.tool_calls.map(tc =>
                `[Tool call: ${tc.function.name}(${tc.function.arguments})]`
              ).join('\n');
              return (m.content ? m.content + '\n' : '') + calls;
            }
            return m.content || '';
          };

          const system   = data.messages.filter(m => m.role === 'system');
          const userMsgs = data.messages.filter(m => m.role === 'user');
          const lastUser = userMsgs.length ? userMsgs[userMsgs.length - 1] : null;

          const parts = [];

          if (system.length) {
            parts.push('=== INSTRUCTIONS ===');
            parts.push(system.map(getText).join('\n'));
          }

          if (tools.length) {
            parts.push('\n=== AVAILABLE TOOLS ===');
            parts.push(
              'You may call one of the following tools by responding ONLY with a ' +
              'JSON block wrapped in <tool_call></tool_call> tags — nothing else before or after. ' +
              'Format:\n' +
              '<tool_call>\n{"name":"<tool_name>","arguments":{<args>}}\n</tool_call>\n\n' +
              'CRITICAL JSON RULES — failure to follow these will break the tool call:\n' +
              '  1. The entire block must be valid JSON.\n' +
              '  2. ALL double-quote characters inside string values must be escaped as \\". ' +
              'This applies especially to file content, HTML, code, and any text containing quotes.\n' +
              '  3. ALL newlines inside string values must be escaped as \\n (not literal newlines).\n' +
              '  4. ALL backslashes inside string values must be escaped as \\\\.\n' +
              '  5. Do NOT wrap string values in single quotes — JSON only uses double quotes.\n\n' +
              'Example of correctly escaped HTML content:\n' +
              '{"name":"write","arguments":{"path":"x.html","content":"<div class=\\"hello\\">Hi</div>\\n"}}\n\n' +
              'Do NOT describe what you would do — actually emit the tag when you need a tool.\n' +
              'If no tool is needed, reply normally in plain text.\n'
            );
            tools.forEach(t => {
              const fn = t.function || t;
              parts.push(`Tool: ${fn.name}`);
              if (fn.description) parts.push(`  Description: ${fn.description}`);
              if (fn.parameters) parts.push(`  Parameters (JSON Schema): ${JSON.stringify(fn.parameters)}`);
            });
          }

          const convMessages = data.messages.filter(m =>
            m.role !== 'system' && m !== lastUser
          );
          if (convMessages.length) {
            parts.push('\n=== CONVERSATION HISTORY ===');
            convMessages.forEach(m => {
              const role = m.role === 'assistant' ? 'Assistant'
                         : m.role === 'tool'      ? 'Tool'
                         : 'User';
              parts.push(`${role}: ${getText(m)}`);
            });
          }

          if (lastUser) {
            parts.push('\n=== YOUR TASK ===');
            parts.push('Respond to this message from the user:');
            parts.push(getText(lastUser));
          }

          prompt = parts.join('\n');
          log('QUEUE', `Built structured prompt from ${data.messages.length} messages, ${tools.length} tools (${prompt.length} chars)`);
          log('QUEUE', `Last user message: "${getText(lastUser || {}).substring(0, 120)}"`);
        } else {
          prompt = data.prompt || "";
          log('QUEUE', `Using direct prompt field (${prompt.length} chars)`);
        }
        if (!prompt) log('QUEUE', 'WARNING: Empty prompt extracted');

        const requestId = Math.random().toString(36).substring(7);
        log('QUEUE', `Assigned ID=${requestId}`);

        if (isStreaming) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
          });
          log('STREAM', `SSE headers sent for ${requestId}`);
        }

        const TIMEOUT_MS = 180000;
        const safetyTimeout = setTimeout(() => {
          if (!PENDING_REQUESTS.has(requestId)) return;
          log('TIMEOUT', `Request ${requestId} expired after ${TIMEOUT_MS/1000}s — closing client, keeping slot for late reply`);
          const p = PENDING_REQUESTS.get(requestId);
          p.timedOut = true;
          try {
            if (p.isStreaming) {
              p.res.write(`data: {"error":"Bridge Timeout"}\n\n`);
              p.res.end();
            } else {
              sendJson(p.res, 504, { error: 'Request timed out after 180s — Gemini is still thinking, reply will be discarded' });
            }
          } catch (e) {  }

          setTimeout(() => {
            if (PENDING_REQUESTS.has(requestId)) {
              log('TIMEOUT', `Purging late-reply slot for ${requestId}`);
              PENDING_REQUESTS.delete(requestId);
            }
          }, 120000);
        }, TIMEOUT_MS);

        PENDING_REQUESTS.set(requestId, { res, isStreaming, timeout: safetyTimeout, hasTools: tools.length > 0 });
        REQUEST_QUEUE.push({ id: requestId, prompt, attachments: data.attachments });
        log('QUEUE', `Queued ${requestId} — queue depth now ${REQUEST_QUEUE.length}`);

      } catch (e) {
        log('ERROR', 'Failed to parse POST body:', e.message);
        sendJson(res, 400, { error: 'Invalid JSON body' });
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/queue') {
    if (REQUEST_QUEUE.length > 0) {
      const item = REQUEST_QUEUE.shift();
      log('POLL', `Serving request ${item.id} to extension (${REQUEST_QUEUE.length} remaining)`);
      return sendJson(res, 200, item);
    }

    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    return res.end();
  }

  if (req.method === 'POST' && url.pathname.startsWith('/response/')) {
    const requestId = url.pathname.split('/')[2];
    log('RESPONSE', `Received reply for ${requestId}`);

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let reply = '';
      try {
        const parsed = JSON.parse(body);
        reply = parsed.reply || '';
        log('RESPONSE', `Reply for ${requestId} — ${reply.length} chars: "${reply.substring(0, 120)}${reply.length > 120 ? '…' : ''}"`);
      } catch (e) {
        log('RESPONSE', `ERROR: Could not parse response body for ${requestId}:`, e.message, '| raw:', body.substring(0, 200));
        res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ ok: false, error: 'invalid body' }));
      }

      const pending = PENDING_REQUESTS.get(requestId);
      if (!pending) {
        log('RESPONSE', `WARNING: No pending request found for ${requestId} — slot fully purged (reply arrived too late)`);
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ ok: false, error: 'no pending request' }));
      }

      if (pending.timedOut) {
        log('RESPONSE', `WARNING: Reply for ${requestId} arrived after client timeout — client already received 504, discarding reply`);
        PENDING_REQUESTS.delete(requestId);
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ ok: false, error: 'client already timed out' }));
      }

      clearTimeout(pending.timeout);
      log('RESPONSE', `Cleared safety timeout for ${requestId}`);

      let toolCallPayload = null;
      if (pending.hasTools && reply) {
        const tcMatch = reply.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/);
        if (tcMatch) {
          const raw = tcMatch[1];
          let parsed = null;

          try {
            parsed = JSON.parse(raw);
            log('TOOL', `Strategy 1 (direct parse) succeeded for ${requestId}`);
          } catch (e1) {
            log('TOOL', `Strategy 1 failed for ${requestId}: ${e1.message} — trying repair`);

            try {
              let repaired = raw;

              repaired = repaired.replace(/("(?:[^"\\]|\\.)*")|(\n)/g, (m, str, nl) => str ? str : '\\n');

              repaired = repaired.replace(
                /("content"\s*:\s*")([\s\S]*?)("(?:\s*,|\s*\}))/,
                (_, open, content, close) => {

                  const fixed = content.replace(/(?<!\\)"/g, '\\"');
                  return open + fixed + close;
                }
              );

              parsed = JSON.parse(repaired);
              log('TOOL', `Strategy 2 (repaired JSON) succeeded for ${requestId}`);
            } catch (e2) {
              log('TOOL', `Strategy 2 failed for ${requestId}: ${e2.message} — trying regex extraction`);

              try {
                const nameMatch = raw.match(/"name"\s*:\s*"([^"]+)"/);
                if (!nameMatch) throw new Error('no name field');
                const toolName = nameMatch[1];

                const argsBlockMatch = raw.match(/"arguments"\s*:\s*\{([\s\S]*)\}\s*\}?\s*$/);
                const argsRaw = argsBlockMatch ? argsBlockMatch[1] : '';

                const args = {};
                const scalarRe = /"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
                let sm;
                while ((sm = scalarRe.exec(argsRaw)) !== null) {
                  if (sm[1] !== 'content') args[sm[1]] = sm[2];
                }

                const contentMatch = argsRaw.match(/"content"\s*:\s*"([\s\S]*)"\s*(?:,\s*"\w+"|$)/);
                if (contentMatch) {

                  args.content = contentMatch[1]
                    .replace(/\\n/g, '\n')
                    .replace(/\\t/g, '\t')
                    .replace(/\\"/g, '"')
                    .replace(/\\\\/g, '\\');
                } else {

                  const greedy = argsRaw.match(/"content"\s*:\s*"([\s\S]*)/);
                  if (greedy) {
                    args.content = greedy[1]
                      .replace(/"\s*\}[\s\S]*$/, '') // strip trailing "}
                      .replace(/\\n/g, '\n')
                      .replace(/\\"/g, '"');
                  }
                }

                parsed = { name: toolName, arguments: args };
                log('TOOL', `Strategy 3 (regex extraction) succeeded for ${requestId}: name=${toolName} fields=${Object.keys(args).join(',')}`);
              } catch (e3) {
                log('TOOL', `All parse strategies failed for ${requestId}. Raw block:\n${raw.substring(0, 300)}`);
              }
            }
          }

          if (parsed) {
            try {
              const callId = 'call_' + Math.random().toString(36).substring(2, 10);
              toolCallPayload = [{
                id: callId,
                type: 'function',
                function: {
                  name: parsed.name,
                  arguments: typeof parsed.arguments === 'string'
                    ? parsed.arguments
                    : JSON.stringify(parsed.arguments || {})
                }
              }];
              log('TOOL', `Tool call ready for ${requestId}: ${parsed.name}(${JSON.stringify(parsed.arguments || {}).substring(0, 120)})`);
            } catch (e) {
              log('TOOL', `Failed to build tool call payload for ${requestId}:`, e.message);
            }
          }
        }
      }

      if (pending.isStreaming) {
        log('STREAM', `Sending SSE chunk for ${requestId} — tool_call=${!!toolCallPayload}`);
        const delta = toolCallPayload
          ? { role: 'assistant', content: null, tool_calls: toolCallPayload }
          : { content: reply };
        const chunk = {
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'gemini-2.0-flash',
          choices: [{
            delta,
            index: 0,
            finish_reason: toolCallPayload ? 'tool_calls' : 'stop'
          }]
        };
        pending.res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        pending.res.write(`data: [DONE]\n\n`);
        pending.res.end();
        log('STREAM', `SSE response completed for ${requestId}`);
      } else {
        const message = toolCallPayload
          ? { role: 'assistant', content: null, tool_calls: toolCallPayload }
          : { role: 'assistant', content: reply };
        const responsePayload = {
          id: requestId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'gemini-2.0-flash',
          choices: [{
            index: 0,
            message,
            finish_reason: toolCallPayload ? 'tool_calls' : 'stop'
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        };
        log('RESPONSE', `Sending JSON response to client for ${requestId} — tool_call=${!!toolCallPayload}`);
        sendJson(pending.res, 200, responsePayload);
        log('RESPONSE', `JSON response sent for ${requestId}`);
      }

      PENDING_REQUESTS.delete(requestId);
      log('RESPONSE', `Removed ${requestId} from pending map (${PENDING_REQUESTS.size} still pending)`);

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  log('404', req.method, url.pathname);
  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  log('STARTUP', `🚀 Gemini Automator Bridge active on port ${PORT}`);
  log('STARTUP', `   POST http://localhost:${PORT}/gemini`);
  log('STARTUP', `   POST http://localhost:${PORT}/v1/chat/completions  (OpenAI-compatible)`);
});