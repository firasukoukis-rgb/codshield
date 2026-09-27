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

const processedOrders = [];

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

// Health Check
app.get('/', (req, res) => {
  res.json({ status: 'ONLINE', service: 'CODShield API (Arabic)', instance: INSTANCE_ID, connected: true });
});

// Converty Webhook (Receives Orders from Store)
app.post('/api/v1/converty/webhook', async (req, res) => {
  try {
    const payload = req.body;
    const orderId = payload.id || payload.order_id || payload.number || `ORD-${Date.now().toString().slice(-4)}`;
    const customer = payload.customer || {};
    const rawPhone = payload.phone || customer.phone || payload.shipping_address?.phone || '';
    const normalizedPhone = normalizeTunisianPhone(rawPhone);
    const customerName = payload.customer_name || customer.name || customer.first_name || 'حريفنا الكريم';

    let productName = 'طلبكم';
    if (payload.line_items && payload.line_items.length > 0) {
      productName = payload.line_items.map(item => `${item.quantity || 1}x ${item.title || item.name}`).join('، ');
    } else if (payload.product_name) {
      productName = payload.product_name;
    }

    const totalAmount = payload.total_price || payload.total || '0.000';
    const city = payload.city || payload.shipping_address?.city || 'تونس';

    const screening = calculateBuyerTrustScore(normalizedPhone);
    if (screening.riskLevel === 'HIGH_RISK_SERIAL_REFUSER') {
      return res.status(200).json({ status: 'BLOCKED_FRAUD', orderId, trustScore: screening.trustScore });
    }

    // Arabic Confirmation Message
    const messageBody = `أهلاً وسهلاً بك ${customerName} ! 👋

شكراً لطلبك من متجرنا:
📦 المنتج: *${productName}*
💵 المبلغ الإجمالي: *${totalAmount} د.ت* (الدفع عند الاستلام)
📍 الوجهة: *${city}*

لقد استلمنا طلبك ونود التأكد مما إذا كنت ترغب في تأكيده للبدء في تجهيزه وشحنه:

👉 أرسل *1* لـ *تأكيد الطلب* ✅
👉 أرسل *2* إذا كنت *تريد مكالمة هاتفية لطرح استفساراتكم* 📞`;

    const waResponse = await sendUltraMsg(`+${normalizedPhone}`, messageBody);
    processedOrders.unshift({ orderId, customerName, phone: normalizedPhone, status: 'AWAITING_REPLY' });

    return res.status(200).json({ status: 'SUCCESS', orderId, waResponse });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UltraMsg Inbound (Customer replies 1 or 2 on WhatsApp in Arabic)
app.post('/api/v1/ultramsg/webhook', async (req, res) => {
  try {
    const data = req.body?.data || req.body;
    const from = (data.from || '').replace(/\D/g, '');
    const text = (data.body || '').trim().toLowerCase();

    // Option 1: Confirm order
    if (text === '1' || text.includes('نعم') || text.includes('تاكيد') || text.includes('تأكيد') || text.includes('oui') || text.includes('confirme')) {
      const confirmReply = `ممتاز! تم تأكيد طلبك بنجاح 🎉

لضمان وصول عامل التوصيل إلى باب منزلك بكل سهولة ودون إزعاج، يُرجى إرسال *موقعك عبر GPS 📍* أو توضيح نقطة قريبة معروفة.`;
      await sendUltraMsg(`+${from}`, confirmReply);

    // Option 2: Wants a call
    } else if (text === '2' || text.includes('اتصال') || text.includes('كلموني') || text.includes('سؤال') || text.includes('استفسار') || text.includes('appel')) {
      const callReply = `تم تسجيل طلبك بنجاح! 📞

سيقوم فريق خدمة العملاء بالاتصال بك في أقرب وقت ممكن للإجابة على جميع استفساراتك قبل شحن الطلب. شكراً لتواصلك معنا 😊`;
      await sendUltraMsg(`+${from}`, callReply);
    }

    res.status(200).send('OK');
  } catch (err) {
    res.status(500).send('Error');
  }
});

app.listen(PORT, () => {
  console.log(`🛡️ CODShield Engine (Arabic) running on port ${PORT}`);
});
