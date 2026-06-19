const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const port = process.env.PORT || 3000;

// Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Temp OTP storage (use Redis in production)
const otpStore = {};

// Health check
app.get('/', (req, res) => {
  res.send('PataKeja API is running');
});

// ===== AUTH ROUTES =====
app.post('/api/auth/send-otp', (req, res) => {
  const { phone } = req.body;
  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  otpStore[phone] = otp;

  console.log(`=== OTP FOR ${phone}: ${otp} ===`);

  res.json({
    success: true,
    message: 'Code sent',
    debug_otp: otp // REMOVE THIS IN PRODUCTION
  });
});

app.post('/api/auth/verify-otp', async (req, res) => {
  const { phone, otp } = req.body;

  if (otpStore[phone] && otpStore[phone] === otp) {
    delete otpStore[phone];

    // Create or get user in Supabase
    const { data: existing } = await supabase
     .from('users')
     .select('*')
     .eq('phone', phone)
     .single();

    let user = existing;
    if (!user) {
      const { data } = await supabase
       .from('users')
       .insert([{ phone, created_at: new Date() }])
       .select()
       .single();
      user = data;
    }

    return res.json({ success: true, user });
  }

  res.json({ success: false, message: 'Invalid code' });
});

// ===== UNLOCK CHECK =====
app.get('/api/unlocks/check', async (req, res) => {
  const { user_id, listing_id } = req.query;

  const { data } = await supabase
   .from('unlocks')
   .select('*')
   .eq('user_id', user_id)
   .eq('listing_id', listing_id)
   .single();

  if (data) {
    // Get caretaker phone from listing
    const { data: listing } = await supabase
     .from('listings')
     .select('caretaker_phone')
     .eq('id', listing_id)
     .single();

    return res.json({ unlocked: true, phone: listing?.caretaker_phone });
  }

  res.json({ unlocked: false });
});

// ===== M-PESA STK PUSH (updated path) =====
app.post('/api/pochi/stkpush', async (req, res) => {
  try {
    const { phone, amount, user_id, listing_id, reference } = req.body;

    // Format phone to 254...
    let formattedPhone = phone.replace(/\s/g, '');
    if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.slice(1);
    if (formattedPhone.startsWith('+')) formattedPhone = formattedPhone.slice(1);

    const auth = Buffer.from(`${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`).toString('base64');

    const tokenRes = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
      headers: { Authorization: `Basic ${auth}` }
    });
    const token = tokenRes.data.access_token;

    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
    const password = Buffer.from(`${process.env.SHORTCODE}${process.env.PASSKEY}${timestamp}`).toString('base64');

    const stkRes = await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: process.env.SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: formattedPhone,
      PartyB: process.env.SHORTCODE,
      PhoneNumber: formattedPhone,
      CallBackURL: process.env.CALLBACK_URL,
      AccountReference: reference || "PataKeja",
      TransactionDesc: "Unlock contact"
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });

    // Store pending payment
    await supabase.from('payments').insert([{
      user_id,
      listing_id,
      phone_number: formattedPhone,
      amount,
      status: 'pending',
      checkout_request_id: stkRes.data.CheckoutRequestID
    }]);

    res.json(stkRes.data);
  } catch (error) {
    console.error('STK Error:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// Keep old endpoint for compatibility
app.post('/stkpush', async (req, res) => {
  req.url = '/api/pochi/stkpush';
  app._router.handle(req, res);
});

// ===== M-PESA CALLBACK =====
app.post('/mpesa/callback', async (req, res) => {
  console.log('M-Pesa Callback:', JSON.stringify(req.body));

  const callback = req.body.Body?.stkCallback;
  if (callback?.ResultCode === 0) {
    const metadata = callback.CallbackMetadata.Item;
    const amount = metadata.find(i => i.Name === 'Amount')?.Value;
    const mpesaReceipt = metadata.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
    const phone = metadata.find(i => i.Name === 'PhoneNumber')?.Value;
    const checkoutId = callback.CheckoutRequestID;

    // Update payment
    const { data: payment } = await supabase
     .from('payments')
     .update({
        status: 'success',
        mpesa_receipt: mpesaReceipt
      })
     .eq('checkout_request_id', checkoutId)
     .select()
     .single();

    // Create unlock
    if (payment) {
      await supabase.from('unlocks').insert([{
        user_id: payment.user_id,
        listing_id: payment.listing_id,
        payment_id: payment.id
      }]);
    }
  }

  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
