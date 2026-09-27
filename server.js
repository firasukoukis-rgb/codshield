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

// Fraud & Serial Refuser Engine
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
  res.json({ status: 'ONLINE', service: 'CODShield API', instance: INSTANCE_ID, connected: true });
});

// Converty Webhook (Receives Orders from Store)
app.post('/api/v1/converty/webhook', async (req, res) => {
  try {
    const payload = req.body;
    const orderId = payload.id || payload.order_id || payload.number || `ORD-${Date.now().toString().slice(-4)}`;
    const customer = payload.customer || {};
    const rawPhone = payload.phone || customer.phone || payload.shipping_address?.phone || '';
    const normalizedPhone = normalizeTunisianPhone(rawPhone);
    const customerName = payload.customer_name || customer.name || customer.first_name || 'Client';

    let productName = 'Votre commande';
    if (payload.line_items && payload.line_items.length > 0) {
      productName = payload.line_items.map(item => `${item.quantity || 1}x ${item.title || item.name}`).join(', ');
    } else if (payload.product_name) {
      productName = payload.product_name;
    }

    const totalAmount = payload.total_price || payload.total || '0.000';
    const city = payload.city || payload.shipping_address?.city || 'Tunisie';

    const screening = calculateBuyerTrustScore(normalizedPhone);
    if (screening.riskLevel === 'HIGH_RISK_SERIAL_REFUSER') {
      return res.status(200).json({ status: 'BLOCKED_FRAUD', orderId, trustScore: screening.trustScore });
    }

    const messageBody = `👋 Aslema ${customerName} !

Merci pour votre commande :
📦 Produit : *${productName}*
💵 Total à payer : *${totalAmount} TND* (Paiement à la livraison)
📍 Destination : *${city}*

Pour préparer et expédier votre colis aujourd'hui :
👉 Répondez *1* pour *Confirmer la commande* ✅
👉 Répondez *2* si *Vous avez une question (Rappelez-moi)* 📞`;

    const waResponse = await sendUltraMsg(`+${normalizedPhone}`, messageBody);
    processedOrders.unshift({ orderId, customerName, phone: normalizedPhone, status: 'AWAITING_REPLY' });

    return res.status(200).json({ status: 'SUCCESS', orderId, waResponse });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UltraMsg Inbound (Customer replies 1 or 2 on WhatsApp)
app.post('/api/v1/ultramsg/webhook', async (req, res) => {
  try {
    const data = req.body?.data || req.body;
    const from = (data.from || '').replace(/\D/g, '');
    const text = (data.body || '').trim().toLowerCase();

    if (text === '1' || text.includes('confirme') || text.includes('oui')) {
      await sendUltraMsg(`+${from}`, `Parfait ! Votre commande est bien confirmée 🎉\n\nPour que le livreur trouve facilement votre porte, vous pouvez nous envoyer votre *localisation GPS 📍* ou un point de repère.`);
    } else if (text === '2' || text.includes('question') || text.includes('rappel') || text.includes('appel')) {
      await sendUltraMsg(`+${from}`, `Demande de rappel enregistrée ! 📞\n\nUn conseiller va vous appeler dans quelques instants pour répondre à toutes vos questions avant l'expédition.`);
    }
    res.status(200).send('OK');
  } catch (err) {
    res.status(500).send('Error');
  }
});

app.listen(PORT, () => {
  console.log(`🛡️ CODShield Engine running on port ${PORT}`);
});
