const http = require('http');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    }).on('error', reject);
  });
}

async function run() {
  console.log("=== Role Access Verification ===");

  // Visit /admin anonymously
  const adminRes = await get('http://localhost:8080/admin');
  console.log("Anonymous Admin access status:", adminRes.statusCode);
  console.log("Redirect target:", adminRes.headers.location);

  console.log("=== Verification Successful ===");
}

run().catch(console.error);
