require('dotenv').config();
const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const INSTANCE_ID = process.env.ULTRAMSG_INSTANCE_ID || 'instance192823';
const TOKEN = process.env.ULTRAMSG_TOKEN || 'vf4yh08blkp6dq89';

const CONVERTY_CLIENT_ID = process.env.CONVERTY_CLIENT_ID || '6ab96993bd786b0eb274f032';
const CONVERTY_CLIENT_SECRET = process.env.CONVERTY_TOKEN_SECRET || '16ec3366-2028-4d80-8542-ac47c427bd88';
const BASE_HOST = 'https://codshield-c8ac.onrender.com';

const KNOWN_SERIAL_REFUSERS = new Set([
  '21650999112', '21655889001', '21622998877'
]);

function normalizeTunisianPhone(rawPhone) {
  let cleaned = (rawPhone || '').replace(/\D/g, '');
  if (cleaned.startsWith('00216')) cleaned = cleaned.substring(2);
  else if (cleaned.startsWith('216') && cleaned.length === 11) return cleaned;
  else if (cleaned.length === 8) cleaned = `216${cleaned}`;
  return cleaned;
}

function calculateBuyerTrustScore(phone) {
  if (KNOWN_SERIAL_REFUSERS.has(phone)) {
    return { trustScore: 8, riskLevel: 'HIGH_RISK_SERIAL_REFUSER' };
  }
  return { trustScore: 96, riskLevel: 'LOW' };
}

function sendUltraMsg(to, body) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams({ token: TOKEN, to, body, priority: '10' }).toString();
    const options = {
      hostname: 'api.ultramsg.com',
      port: 443,
      path: `/${INSTANCE_ID}/messages/chat`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (d) => { responseBody += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(responseBody)); } catch (e) { resolve({ raw: responseBody }); }
      });
    });
    req.on('error', (e) => reject(e));
    req.write(data);
    req.end();
  });
}

function convertyApiRequest({ path, method, headers, data }) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'partner.converty.shop',
      port: 443,
      path,
      method: method || 'GET',
      headers: headers || {}
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, raw: body }); }
      });
    });
    req.on('error', (e) => reject(e));
    if (data) req.write(data);
    req.end();
  });
}

// 1. Home Page with 1-Click Connect Button
app.get('/', (req, res) => {
  res.send(`
    <html lang="ar" dir="rtl">
    <body style="background:#0f172a; color:#f8fafc; font-family:sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;">
      <div style="background:#1e293b; padding:30px; border-radius:16px; text-align:center; max-width:400px; box-shadow:0 10px 25px rgba(0,0,0,0.5);">
        <h1 style="color:#10b981; font-size:24px;">🛡️ CODShield</h1>
        <p style="color:#94a3b8; font-size:14px;">نظام تأكيد الطلبات عبر الواتساب لكنفيرتي</p>
        <a href="/connect" style="display:block; background:#10b981; color:#fff; text-decoration:none; padding:12px; border-radius:10px; font-weight:bold; margin-top:20px;">
          🔗 ربط متجر كنفيرتي (Connect Store)
        </a>
      </div>
    </body>
    </html>
  `);
});

// 2. Start OAuth
app.get('/connect', (req, res) => {
  const redirectUri = `${BASE_HOST}/callback`;
  const scopes = 'read-orders update-orders read-hooks create-hooks read-stores read-products';
  const state = 'codshield_tn_' + Date.now();
  const authUrl = `https://partner.converty.shop/oauth2/authorize?response_type=code&client_id=${CONVERTY_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${state}`;
  res.redirect(authUrl);
});

// 3. OAuth Callback: Automatically exchange code & subscribe to Webhook
async function handleCallback(req, res) {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');

  try {
    const redirectUri = `${BASE_HOST}/callback`;
    const tokenRequestBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: CONVERTY_CLIENT_ID,
      client_secret: CONVERTY_CLIENT_SECRET,
      redirect_uri: redirectUri
    }).toString();

    const tokenResponse = await convertyApiRequest({
      path: '/oauth2/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(tokenRequestBody) },
      data: tokenRequestBody
    });

    const accessToken = tokenResponse.data?.access_token;
    if (!accessToken) return res.status(400).send('Failed to get access token');

    // Auto-subscribe to order.create webhook (Converty Docs page 24)
    const subscribeBody = JSON.stringify({
      targetUrl: `${BASE_HOST}/api/v1/converty/webhook`,
      event: 'order.create'
    });

    await convertyApiRequest({
      path: '/api/v1/hooks/subscribe',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(subscribeBody)
      },
      data: subscribeBody
    });

    res.send(`
      <html lang="ar" dir="rtl">
      <body style="background:#0f172a; color:#f8fafc; font-family:sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;">
        <div style="background:#1e293b; padding:30px; border-radius:16px; text-align:center; max-width:400px;">
          <h1 style="color:#10b981; font-size:24px;">🎉 تم الربط بنجاح!</h1>
          <p style="color:#cbd5e1; font-size:14px;">تم تفعيل Webhook تلقائياً. كل طلب جديد سيصلك إشعار واتساب له فوراً.</p>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('OAuth Error: ' + err.message);
  }
}

app.get('/callback', handleCallback);
app.get('/api/v1/converty/callback', handleCallback);

// 4. Receives Orders from Converty
app.post('/api/v1/converty/webhook', async (req, res) => {
  try {
    const payload = req.body;
    const orderId = payload.id || payload.order_id || payload.number || `ORD-${Date.now().toString().slice(-4)}`;
    const customer = payload.customer || {};
    const rawPhone = payload.phone || customer.phone || payload.shipping_address?.phone || '';
    const normalizedPhone = normalizeTunisianPhone(rawPhone);
    const customerName = payload.customer_name || customer.name || customer.first_name || 'حريفنا الكريم';

    let productName = 'طلبكم';
    if (payload.cart && Array.isArray(payload.cart) && payload.cart.length > 0) {
      productName = payload.cart.map(item => `${item.quantity || 1}x ${item.product?.name || 'منتج'}`).join('، ');
    } else if (payload.line_items && payload.line_items.length > 0) {
      productName = payload.line_items.map(item => `${item.quantity || 1}x ${item.title || item.name}`).join('، ');
    } else if (payload.product_name) {
      productName = payload.product_name;
    }

    const totalAmount = payload.total?.totalPrice || payload.total_price || payload.total || '0.000';
    const city = payload.customer?.city || payload.city || payload.shipping_address?.city || 'تونس';

    const screening = calculateBuyerTrustScore(normalizedPhone);
    if (screening.riskLevel === 'HIGH_RISK_SERIAL_REFUSER') {
      return res.status(200).json({ status: 'BLOCKED_FRAUD', orderId, trustScore: screening.trustScore });
    }

    const messageBody = `أهلاً وسهلاً بك ${customerName} ! 👋

شكراً لطلبك من متجرنا:
📦 المنتج: *${productName}*
💵 المبلغ الإجمالي: *${totalAmount} د.ت* (الدفع عند الاستلام)
📍 الوجهة: *${city}*

لقد استلمنا طلبك ونود التأكد مما إذا كنت ترغب في تأكيده للبدء في تجهيزه وشحنه:

👉 أرسل *1* لـ *تأكيد الطلب* ✅
👉 أرسل *2* إذا كنت *تريد مكالمة هاتفية لطرح استفساراتكم* 📞`;

    const waResponse = await sendUltraMsg(`+${normalizedPhone}`, messageBody);
    return res.status(200).json({ status: 'SUCCESS', orderId, waResponse });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Inbound WhatsApp Replies
app.post('/api/v1/ultramsg/webhook', async (req, res) => {
  try {
    const data = req.body?.data || req.body;
    const from = (data.from || '').replace(/\D/g, '');
    const text = (data.body || '').trim().toLowerCase();

    if (text === '1' || text.includes('نعم') || text.includes('تاكيد') || text.includes('تأكيد') || text.includes('oui') || text.includes('confirme')) {
      await sendUltraMsg(`+${from}`, `ممتاز! تم تأكيد طلبك بنجاح 🎉\n\nلضمان وصول عامل التوصيل إلى باب منزلك بكل سهولة ودون إزعاج، يُرجى إرسال *موقعك عبر GPS 📍* أو توضيح نقطة قريبة معروفة.`);
    } else if (text === '2' || text.includes('اتصال') || text.includes('كلموني') || text.includes('سؤال') || text.includes('استفسار') || text.includes('appel')) {
      await sendUltraMsg(`+${from}`, `تم تسجيل طلبك بنجاح! 📞\n\nسيقوم فريق خدمة العملاء بالاتصال بك في أقرب وقت ممكن للإجابة على جميع استفساراتك قبل شحن الطلب. شكراً لتواصلك معنا 😊`);
    }
    res.status(200).send('OK');
  } catch (err) {
    res.status(500).send('Error');
  }
});

app.listen(PORT, () => {
  console.log(`🛡️ CODShield Engine running on port ${PORT}`);
});
