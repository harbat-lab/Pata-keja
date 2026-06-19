const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const otpStore = new Map();

app.get('/', (req, res) => res.send('Pata Keja + IntaSend ✅'));

// OTP (same)
app.post('/api/auth/send-otp', (req, res) => {
  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  otpStore.set(req.body.phone, otp);
  console.log('OTP', req.body.phone, otp);
  res.json({ success: true, debug_otp: otp });
});
app.post('/api/auth/verify-otp', (req, res) => {
  const ok = otpStore.get(req.body.phone) === req.body.otp;
  res.json({ success: ok, user: { id: req.body.phone, phone: req.body.phone } });
});

// INTASEND STK PUSH
app.post('/api/mpesa/stkpush', async (req, res) => {
  const { phone, amount, user_id, listing_id } = req.body;
  console.log('INTASEND PAY', phone, amount);
  
  try {
    const { data } = await axios.post('https://sandbox.intasend.com/api/v1/payment/mpesa-stk-push/', {
      first_name: 'Pata',
      last_name: 'Keja',
      email: 'test@patakeja.com',
      phone_number: phone,
      amount: amount,
      api_ref: listing_id,
      host: 'https://pata-keja-oo6v.onrender.com'
    }, {
      headers: {
        'X-IntaSend-Public-API-Key': process.env.INTASEND_PUB,
        'Authorization': `Bearer ${process.env.INTASEND_SECRET}`
      }
    });

    await supa.from('unlocks').insert([{
      user_id,
      listing_id,
      mpesa_receipt: data.invoice.invoice_id,
      amount
    }]);

    console.log('✅ IntaSend sent', data);
    res.json({ ResponseCode: '0', CheckoutRequestID: data.invoice.invoice_id });
    
  } catch (e) {
    console.error('❌ IntaSend error', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data });
  }
});

app.post('/api/pochi/stkpush', (req, res, next) => { req.url = '/api/mpesa/stkpush'; app._router.handle(req, res, next); });

app.get('/api/unlocks/check', async (req, res) => {
  const { data: unlock } = await supa.from('unlocks').select('*').eq('user_id', req.query.user_id).eq('listing_id', req.query.listing_id).maybeSingle();
  const { data: listing } = await supa.from('listings').select('caretaker_phone').eq('id', req.query.listing_id).single();
  res.json({ unlocked: !!unlock, phone: listing?.caretaker_phone });
});

app.listen(process.env.PORT || 3000);
