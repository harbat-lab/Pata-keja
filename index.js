const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// --- Supabase ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// --- Simple OTP store (in-memory) ---
const otpStore = new Map();

// --- HEALTH CHECK ---
app.get('/', (req, res) => {
  res.send('Pata Keja API running ✅');
});

// ====================
// AUTH
// ====================
app.post('/api/auth/send-otp', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  
  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  otpStore.set(phone, { otp, expires: Date.now() + 300000 }); // 5 min
  
  console.log(`🔑 OTP for ${phone}: ${otp}`);
  // In production, send via Africa's Talking SMS
  res.json({ success: true, debug_otp: otp });
});

app.post('/api/auth/verify-otp', (req, res) => {
  const { phone, otp } = req.body;
  const stored = otpStore.get(phone);
  
  if (!stored || stored.otp !== otp || Date.now() > stored.expires) {
    return res.json({ success: false, error: 'Invalid or expired OTP' });
  }
  
  otpStore.delete(phone);
  res.json({ success: true, user: { id: phone, phone } });
});

// ====================
// DARAJA M-PESA
// ====================
async function getDarajaToken() {
  const auth = Buffer.from(
    `${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`
  ).toString('base64');
  
  const { data } = await axios.get(
    'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return data.access_token;
}

app.post('/api/mpesa/stkpush', async (req, res) => {
  const { phone, amount, user_id, listing_id } = req.body;
  
  try {
    const token = await getDarajaToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(
      process.env.SHORTCODE + process.env.PASSKEY + timestamp
    ).toString('base64');

    const payload = {
      BusinessShortCode: process.env.SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount || 100,
      PartyA: phone,
      PartyB: process.env.SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: process.env.CALLBACK_URL,
      AccountReference: 'PataKeja',
      TransactionDesc: 'Unlock contact'
    };

    const { data } = await axios.post(
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // Save unlock attempt
    await supabase.from('unlocks').insert([{
      user_id,
      listing_id,
      mpesa_receipt: data.CheckoutRequestID,
      amount
    }]);

    console.log('✅ STK sent:', data.CheckoutRequestID);
    res.json(data);
    
  } catch (error) {
    console.error('❌ STK Error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'STK push failed', 
      details: error.response?.data 
    });
  }
});

// Alias for old frontend code
app.post('/api/pochi/stkpush', (req, res, next) => {
  req.url = '/api/mpesa/stkpush';
  app._router.handle(req, res, next);
});

// Callback from Safaricom
app.post('/api/mpesa/callback', async (req, res) => {
  console.log('📞 M-Pesa callback:', JSON.stringify(req.body));
  res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

// ====================
// START SERVER
// ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Pata Keja backend running on port ${PORT}`);
});
