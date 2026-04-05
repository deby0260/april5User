const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// MIME types for different file extensions
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  // Parse URL and remove query parameters for file serving
  let filePath = req.url.split('?')[0];
  
  // Default to index.html for root requests
  if (filePath === '/') {
    filePath = '/index.html';
  }
  
  // Construct full file path
  const fullPath = path.join(PUBLIC_DIR, filePath);
  
  // Get file extension for MIME type
  const ext = path.extname(fullPath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  
  // Check if file exists
  fs.access(fullPath, fs.constants.F_OK, (err) => {
    if (err) {
      // File not found
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>404 - Not Found</title></head>
        <body>
          <h1>404 - File Not Found</h1>
          <p>The requested file <code>${filePath}</code> was not found.</p>
          <p><a href="/">Go to Home</a></p>
        </body>
        </html>
      `);
      return;
    }
    
    // Read and serve the file
    fs.readFile(fullPath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>500 - Server Error</title></head>
          <body>
            <h1>500 - Internal Server Error</h1>
            <p>Error reading file: ${err.message}</p>
          </body>
          </html>
        `);
        return;
      }
      
      // Set appropriate headers
      res.writeHead(200, { 
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      
      res.end(data);
    });
  });
});

server.listen(PORT, () => {
  console.log(`🚀 FetchSafe Website Server running at:`);
  console.log(`   Local:    http://localhost:${PORT}`);
  console.log(`   Network:  http://[your-ip]:${PORT}`);
  console.log(`\n📁 Serving files from: ${PUBLIC_DIR}`);
  console.log(`\n📱 QR codes will now point to: http://localhost:${PORT}`);
  console.log(`\n⚠️  Make sure your phone is on the same WiFi network!`);
});

// Handle server shutdown gracefully
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  server.close(() => {
    console.log('✅ Server closed.');
    process.exit(0);
  });
});
