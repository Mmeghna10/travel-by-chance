const http = require('http');

http.get('http://localhost:8080/api/search-suggestions?q=mumbai', (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    console.log("Suggestions for 'mumbai':", JSON.parse(data));
  });
}).on('error', (err) => {
  console.error("Error:", err.message);
});
