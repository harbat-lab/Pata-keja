const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const otpStore = new Map();

// --- AUTH (same as before) ---
app.post('/api/auth/send-otp', (req, res) => {
  const { phone } = req.body;
  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  otpStore.set(phone, { otp, expires: Date.now() + 300000 });
  console.log(`OTP ${phone}: ${otp}`);
  res.json({ success: true, debug_otp: otp });
});

app.post('/api/auth/verify-otp', (req, res) => {
  const { phone, otp } = req.body;
  const stored = otpStore.get(phone);
  if (!stored || stored.otp!== otp) return res.json({ success: false });
  otpStore.delete(phone);
  res.json({ success: true, user: { id: phone, phone } });
});

// --- DARAJA STK ---
async function getToken() {
  const auth = Buffer.from(`${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`).toString('base64');
  const { data } = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
    headers: { Authorization: `Basic ${auth}` }
  });
  return data.access_token;
}

app.post('/api/mpesa/stkpush', async (req, res) => {
  const { phone, amount, user_id, listing_id } = req.body;
  try {
    const token = await getToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0,14);
    const password = Buffer.from(process.env.SHORTCODE + process.env.PASSKEY + timestamp).toString('base64');

    const { data } = await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: process.env.SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: process.env.SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: process.env.CALLBACK_URL,
      AccountReference: 'PataKeja',
      TransactionDesc: 'Unlock contact'
    }, { headers: { Authorization: `Bearer ${token}` }});

    await supabase.from('unlocks').upsert([{ user_id, listing_id, mpesa_receipt: data.CheckoutRequestID, amount }]);
    res.json(data);
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: 'STK failed' });
  }
});

// --- Frontend expects /api/pochi/stkpush, so alias it ---
app.post('/api/pochi/stkpush', (req, res) => {
  req.url = '/api/mpesa/stkpush';
  app._router.handle(req, res);
});

app.listen(process.env.PORT || 3000);
