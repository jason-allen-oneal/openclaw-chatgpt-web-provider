import http from "node:http";

const port = 19_172;
let completionRequests = 0;

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (request.method === "GET" && url.pathname === "/v1/models") {
    sendJson(response, 200, {
      object: "list",
      data: [{ id: "always-429", object: "model", owned_by: "canary" }],
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    completionRequests += 1;
    console.error(`failing-primary request ${completionRequests}: POST /v1/chat/completions`);
    request.resume();
    sendJson(response, 429, {
      error: {
        message: "synthetic canary rate limit",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    });
    return;
  }
  request.resume();
  sendJson(response, 404, { error: { message: "not found" } });
});

server.listen(port, "127.0.0.1", () => {
  console.error(`failing-primary ready on 127.0.0.1:${port}`);
});

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
