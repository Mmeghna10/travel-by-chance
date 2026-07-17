const dns = require('dns').promises;

async function test() {
  try {
    const addresses = await dns.resolveSrv('_mongodb._tcp.travelbychance.cnzyair.mongodb.net');
    console.log('Success resolving SRV:', addresses);
  } catch (err) {
    console.error('Failed standard resolution:', err);
    
    // Let's try setting servers to 8.8.8.8
    try {
      require('dns').setServers(['8.8.8.8', '8.8.4.4']);
      console.log('Set DNS servers to 8.8.8.8');
      const addresses2 = await dns.resolveSrv('_mongodb._tcp.travelbychance.cnzyair.mongodb.net');
      console.log('Success with 8.8.8.8:', addresses2);
    } catch (err2) {
      console.error('Failed with 8.8.8.8:', err2);
    }
  }
}

test();
