// Production dashboard route gateway: all HTML/assets are served and gated by the API.
// No jobs, credentials, or static files live here.
import http from "node:http";
const port = Number(process.env.PORT ?? 23183);
http.createServer((req, res) => {
  const upstream = http.request({
    hostname: "127.0.0.1", port: Number(process.env.API_PORT ?? 8080),
    method: req.method, path: req.url, headers: req.headers,
  }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
  });
  upstream.on("error", () => {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("API unavailable");
  });
  req.pipe(upstream);
}).listen(port, "0.0.0.0");
