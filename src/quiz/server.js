const http = require('http');

function startHealthServer(port = process.env.PORT || 3000) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'quiz-pipeline-bot', uptime: process.uptime() }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Quiz Pipeline Bot running');
  });

  server.listen(port, () => {
    console.log(`[POLL-CTRL] Health server listening on port ${port}`);
  });
  return server;
}

module.exports = { startHealthServer };
