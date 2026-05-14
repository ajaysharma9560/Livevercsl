// Token environment variable se lega - GitHub mein nahi dikhega
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;  // Aapke token ke liye

let lastSeen = null;
let statusHistory = [];

// OPTIONS request handle (CORS preflight)
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

// POST - App open/close status update
export async function POST(request) {
  try {
    const body = await request.json();
    const { status, deviceId = 'default' } = body;
    
    lastSeen = Date.now();
    
    // History maintain karo
    statusHistory.unshift({
      status: status,
      timestamp: lastSeen,
      deviceId: deviceId
    });
    
    // Sirf last 10 entries rakho
    if (statusHistory.length > 10) statusHistory.pop();
    
    // Agar token hai to Vercel API call bhi kar sakte ho (optional)
    if (VERCEL_TOKEN) {
      try {
        await fetch('https://api.vercel.com/v9/projects', {
          headers: { 'Authorization': `Bearer ${VERCEL_TOKEN}` }
        });
        console.log('✅ Vercel API verified');
      } catch(e) {
        console.log('⚠️ Vercel API call failed:', e.message);
      }
    }
    
    return new Response(JSON.stringify({ 
      success: true, 
      status: status,
      timestamp: lastSeen,
      message: 'Status updated successfully'
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
    
  } catch(error) {
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message 
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}

// GET - Current status fetch karne ke liye
export async function GET(request) {
  const url = new URL(request.url);
  const history = url.searchParams.get('history') === 'true';
  
  const isActive = lastSeen && (Date.now() - lastSeen) < 60000;
  
  const response = {
    status: isActive ? 'active' : 'off',
    lastSeen: lastSeen,
    lastSeenHuman: lastSeen ? new Date(lastSeen).toLocaleString() : null,
    isActive: isActive,
    serverTime: Date.now()
  };
  
  if (history) {
    response.history = statusHistory;
  }
  
  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
