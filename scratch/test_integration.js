const http = require('http');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function post(url, payload, cookie = '') {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 80,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(payload)),
      }
    };
    if (cookie) {
      options.headers['Cookie'] = cookie;
    }
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.write(JSON.stringify(payload));
    req.end();
  });
}

async function test() {
  console.log("=== Integration Test Started ===");
  
  // Test autocomplete suggestions
  const sugRes = await get('http://localhost:8080/api/search-suggestions?q=delhi');
  console.log("Autocomplete status:", sugRes.statusCode);
  const suggestions = JSON.parse(sugRes.body);
  console.log("Suggestions for 'delhi':", suggestions);
  
  // Test POST /bookings when unauthorized
  const bookingPayload = {
    listingId: suggestions[0]?._id || '6a59f84cb01f92f32d3f4ecc',
    checkIn: '2026-08-10',
    checkOut: '2026-08-15'
  };
  const bookRes = await post('http://localhost:8080/bookings', bookingPayload);
  console.log("Unauthorized Booking status:", bookRes.statusCode);
  console.log("Unauthorized Booking response:", bookRes.body);
  
  console.log("=== Integration Test Finished ===");
}

test().catch(console.error);
