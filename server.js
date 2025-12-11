require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Groq } = require('groq-sdk');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { compressAudio } = require('./compressAudio');

const app = express();
const PORT = process.env.PORT || 3004;

// Initialize Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// MCP Services URLs
const MCP_A_URL = 'http://localhost:3001';
const MCP_B_URL = 'http://localhost:3002';

// Log konfigurasi
console.log('Konfigurasi:');
console.log('- MCP A URL:', MCP_A_URL);
console.log('- MCP B URL:', MCP_B_URL);
console.log('- Groq Model:', 'mixtral-8x7b-32768');

const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.use(express.json());

// Log semua request
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  console.log('Headers:', req.headers);
  console.log('Body:', req.body);
  next();
});
app.use(express.static('public'));

// Multer configuration for audio uploads
const upload = multer({ dest: 'uploads/' });

// ============================================
// SESSION MANAGEMENT & CART SYSTEM
// ============================================

// In-memory session storage (untuk demo, production use Redis/Database)
const userSessions = new Map();

// Helper: Get or create session
function getSession(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      cart: [],
      awaitingConfirmation: false,
      orderNumber: null,
      conversationHistory: [] // Store conversation context
    });
  }
  return userSessions.get(userId);
}

// Helper: Add message to conversation history
function addToConversationHistory(userId, role, content) {
  const session = getSession(userId);
  session.conversationHistory.push({ role, content });

  // Keep only last 10 messages (5 exchanges) to avoid token limit
  const maxMessages = 10;
  if (session.conversationHistory.length > maxMessages) {
    session.conversationHistory = session.conversationHistory.slice(-maxMessages);
  }
}

// Helper: Get conversation messages for Groq API
function getConversationMessages(userId, systemPrompt) {
  const session = getSession(userId);
  return [
    { role: 'system', content: systemPrompt },
    ...session.conversationHistory
  ];
}

// New helper to process a chat message and generate a response
async function processMessage(userId, message) {
  const session = getSession(userId);
  const processedMessage = message.toLowerCase().trim();

  // Confirmation handler
  const confirmKeywords = ['iya', 'ya', 'ok', 'oke', 'confirm', 'benar', 'betul', 'lanjut', 'setuju', 'yes', 'yup', 'sip'];
  const isConfirmation = (matchesKeyword(processedMessage, confirmKeywords, 2) ||
    confirmKeywords.some(keyword => processedMessage === keyword || processedMessage.includes(keyword))) &&
    processedMessage.split(' ').length <= 3;

  if (isConfirmation && session.awaitingConfirmation && session.cart.length > 0) {
    const orderNumber = 'ORD-' + Date.now();
    session.orderNumber = orderNumber;
    for (const item of session.cart) {
      await createOrder({
        product: item.product,
        quantity: item.quantity,
        customer: 'Pelanggan',
        date: new Date().toISOString()
      });
    }
    const paidReceipt = generateReceipt(session.cart, true, orderNumber);
    addToConversationHistory(userId, 'user', message);
    addToConversationHistory(userId, 'assistant', paidReceipt);
    clearCart(userId);
    return paidReceipt;
  }

  // View cart handler
  const cartKeywords = ['total', 'keranjang', 'pesanan', 'lihat pesanan', 'cek pesanan', 'nota'];
  const isViewCart = cartKeywords.some(keyword => processedMessage.includes(keyword)) &&
    !processedMessage.includes('stok') &&
    processedMessage.split(' ').length <= 4;

  if (isViewCart) {
    if (session.cart.length > 0) {
      const receipt = generateReceipt(session.cart, false);
      session.awaitingConfirmation = true;
      addToConversationHistory(userId, 'user', message);
      addToConversationHistory(userId, 'assistant', receipt);
      return receipt;
    } else {
      const emptyCartMsg = 'Keranjang belanja Anda masih kosong. Mohon lakukan pesanan terlebih dahulu. 🛒\n\nContoh: "Pesan 2 buku"';
      addToConversationHistory(userId, 'user', message);
      addToConversationHistory(userId, 'assistant', emptyCartMsg);
      return emptyCartMsg;
    }
  }

  // Cancel handler
  const cancelKeywords = ['batal', 'cancel', 'hapus pesanan', 'kosongkan', 'reset'];
  const isCancel = cancelKeywords.some(keyword => processedMessage.includes(keyword));
  if (isCancel && session.cart.length > 0) {
    const cancelMsg = 'Pesanan telah dibatalkan. Keranjang belanja dikosongkan. ❌\n\nSilakan mulai pesanan baru.';
    addToConversationHistory(userId, 'user', message);
    addToConversationHistory(userId, 'assistant', cancelMsg);
    clearCart(userId);
    return cancelMsg;
  }

  // Catalog query handler (existing logic)
  console.log('Checking catalog query for message:', processedMessage);
  const catalogKeywords = [
    'produk apa', 'apa saja', 'yang tersedia',
    'list produk', 'daftar produk', 'katalog',
    'produk tersedia', 'barang apa', 'jualan apa',
    'apa produk', 'produk yang ada'
  ];
  const specificProducts = ['buku', 'pensil', 'laptop'];
  const mentionsSpecificProduct = specificProducts.some(prod => processedMessage.includes(prod));
  const hasNumber = /\d+/.test(processedMessage);
  const isCatalogQuery = !mentionsSpecificProduct && !hasNumber && (
    catalogKeywords.some(phrase => processedMessage.includes(phrase)) ||
    (processedMessage.includes('produk') && (processedMessage.includes('apa') || processedMessage.includes('tersedia') || processedMessage.includes('ada'))) ||
    (processedMessage.includes('barang') && (processedMessage.includes('apa') || processedMessage.includes('tersedia') || processedMessage.includes('ada'))) ||
    (processedMessage.includes('apa') && processedMessage.includes('saja'))
  );
  if (isCatalogQuery) {
    const catalogResponse = `Kami memiliki 3 produk unggulan: ✨\n\n📚 Buku - Rp 30.000/unit\n✏️ Pensil - Rp 4.000/unit\n💻 Laptop - Rp 7.500.000/unit\n\nProduk mana yang ingin Anda pesan?`;
    addToConversationHistory(userId, 'user', message);
    addToConversationHistory(userId, 'assistant', catalogResponse);
    return catalogResponse;
  }

  // Price inquiry handler
  const priceKeywords = ['harga', 'berapa', 'price', 'biaya', 'bayar'];
  const isPriceQuery = priceKeywords.some(keyword => processedMessage.includes(keyword)) &&
    !processedMessage.includes('total') &&
    !processedMessage.includes('stok') &&
    !processedMessage.includes('sisa') &&
    !processedMessage.includes('jumlah');
  if (isPriceQuery) {
    const productNames = ['buku', 'pensil', 'laptop'];
    const mentionedProduct = productNames.find(prod => processedMessage.includes(prod));
    if (mentionedProduct) {
      const stockInfo = await checkStock(mentionedProduct);
      if (stockInfo.status === 'success') {
        const emoji = mentionedProduct === 'buku' ? '📚' : mentionedProduct === 'pensil' ? '✏️' : '💻';
        const priceResponse = `${emoji} Harga ${mentionedProduct.charAt(0).toUpperCase() + mentionedProduct.slice(1)} adalah ${formatRupiah(stockInfo.price)} per unit.\n\nApakah Anda ingin memesan? Silakan sebutkan jumlah yang diinginkan.`;
        addToConversationHistory(userId, 'user', message);
        addToConversationHistory(userId, 'assistant', priceResponse);
        return priceResponse;
      } else {
        const notAvailableResponse = `Maaf, ${mentionedProduct} sedang tidak tersedia. Produk lain yang tersedia:\n📚 Buku - ${formatRupiah(30000)}/unit\n✏️ Pensil - ${formatRupiah(4000)}/unit\n💻 Laptop - ${formatRupiah(7500000)}/unit`;
        addToConversationHistory(userId, 'user', message);
        addToConversationHistory(userId, 'assistant', notAvailableResponse);
        return notAvailableResponse;
      }
    } else {
      const allPricesResponse = `📋 Daftar Harga Produk Kami:\n\n📚 Buku - ${formatRupiah(30000)} per unit\n✏️ Pensil - ${formatRupiah(4000)} per unit\n💻 Laptop - ${formatRupiah(7500000)} per unit\n\nProduk mana yang ingin Anda pesan?`;
      addToConversationHistory(userId, 'user', message);
      addToConversationHistory(userId, 'assistant', allPricesResponse);
      return allPricesResponse;
    }
  }

  // Stock query handler (existing logic simplified)
  const stockKeywords = ['stok', 'ada', 'berapa', 'sisa', 'tersedia', 'jumlah'];
  const isStockQuery = stockKeywords.some(keyword => processedMessage.includes(keyword)) || /(cek|lihat|tampilkan|info)\s+(stok|barang|produk)/i.test(processedMessage);
  if (isStockQuery) {
    // For brevity, reuse existing endpoint logic by delegating to /api/stock (not implemented here). Return placeholder.
    const placeholder = 'Fitur cek stok belum diimplementasikan di voice endpoint.';
    addToConversationHistory(userId, 'user', message);
    addToConversationHistory(userId, 'assistant', placeholder);
    return placeholder;
  }

  // Greeting handler
  const greetingKeywords = ['halo', 'hai', 'hello', 'hi', 'allo', 'hola', 'hey', 'selamat', 'hallo'];
  const isGreeting = greetingKeywords.some(keyword => processedMessage.includes(keyword)) &&
    processedMessage.split(' ').length <= 5;
  if (isGreeting) {
    const greetingResponses = [
      'Selamat datang di toko kami! ✨\n\nKami memiliki berbagai produk berkualitas yang siap memenuhi kebutuhan Anda.\n\nApakah Anda ingin mengetahui produk yang tersedia atau langsung melakukan pemesanan? Saya siap membantu Anda. 🛍️',
      'Selamat datang! Terima kasih telah mengunjungi toko kami. 🎉\n\nKami menyediakan produk-produk pilihan dengan harga terbaik.\n\nAda yang bisa saya bantu? Anda dapat melihat produk atau langsung melakukan pemesanan.',
      'Selamat datang! 👋\n\nTerima kasih telah mengunjungi toko kami. Kami memiliki berbagai produk berkualitas untuk kebutuhan Anda.\n\nSilakan tanyakan informasi produk yang Anda butuhkan atau langsung lakukan pemesanan. 🛒',
      'Selamat datang! 🌟\n\nKami siap membantu Anda menemukan produk yang tepat dengan harga terbaik.\n\nApakah Anda ingin melihat katalog produk kami atau sudah memiliki produk yang ingin dipesan?',
      'Selamat datang! Senang dapat melayani Anda. 🎊\n\nToko kami menyediakan produk berkualitas dengan pelayanan terbaik.\n\nApa yang dapat saya bantu hari ini? Cek stok, informasi harga, atau langsung melakukan pemesanan?'
    ];
    const greetingMsg = greetingResponses[Math.floor(Math.random() * greetingResponses.length)];
    addToConversationHistory(userId, 'user', message);
    addToConversationHistory(userId, 'assistant', greetingMsg);
    return greetingMsg;
  }

  // Fallback to Groq AI
  const systemPrompt = `Anda adalah asisten toko inventaris yang profesional, sopan, dan membantu. ...`;
  const conversationMessages = getConversationMessages(userId, systemPrompt);
  const completion = await groq.chat.completions.create({
    messages: conversationMessages,
    model: "llama-3.3-70b-versatile",
    temperature: 0.8,
    max_tokens: 200
  });
  let botResponse = completion.choices[0]?.message?.content || '';
  if (!botResponse || botResponse.length < 10) {
    const helpfulResponses = [
      'Mohon maaf, saya kurang memahami maksud Anda.\n\nSilakan coba:\n• "Cek stok buku" - untuk melihat stok\n• "Pesan 2 pensil" - untuk pemesanan\n• "Total berapa?" - untuk melihat keranjang\n\nAtau tanyakan informasi yang Anda perlukan, saya siap membantu.',
      'Mohon maaf, saya belum memahami maksud Anda. 🤔\n\nUntuk melayani Anda lebih baik, silakan:\n✓ Tanyakan stok produk\n✓ Lakukan pemesanan\n✓ Tanyakan harga produk\n\nAda yang dapat saya bantu?',
      'Mohon maaf, sepertinya ada kesalahan ketik atau saya yang kurang memahami.\n\nSaya dapat membantu:\n📦 Cek ketersediaan barang\n🛒 Proses pesanan\n💰 Informasi harga\n\nSilakan coba lagi. Saya siap membantu Anda.'
    ];
    botResponse = helpfulResponses[Math.floor(Math.random() * helpfulResponses.length)];
  }
  const greetings = ['Halo!', 'Hai!', 'Halo, ada yang bisa saya bantu?'];
  const randomGreeting = greetings[Math.floor(Math.random() * greetings.length)];
  if (botResponse.split(' ').length < 10 && !botResponse.includes('?') && !botResponse.includes('!') && !botResponse.includes('.')) {
    botResponse = `${randomGreeting} ${botResponse}`;
  }
  addToConversationHistory(userId, 'assistant', botResponse);
  return botResponse;
}

// Updated /api/chat to use processMessage
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || message.trim() === '') {
      return res.status(400).json({ error: 'Pesan tidak boleh kosong' });
    }
    const userId = 'user_default';
    const response = await processMessage(userId, message);
    res.json({ response });
  } catch (error) {
    console.error('Error in chat endpoint:', error);
    res.status(500).json({ error: 'Terjadi kesalahan saat memproses permintaan Anda.' });
  }
});

// Updated /api/transcribe to forward to processMessage
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    console.log('[Transcribe] Request received');
    if (!req.file) {
      console.error('[Transcribe] No audio file uploaded');
      return res.status(400).json({ error: 'No audio file provided' });
    }
    if (!process.env.GROQ_API_KEY) {
      console.error('[Transcribe] GROQ_API_KEY not set!');
      fs.unlinkSync(req.file.path);
      return res.status(500).json({ error: 'Server configuration error' });
    }
    console.log('[Transcribe] Sending to Groq Whisper API...');
    // Define path for compressed audio
    const compressedPath = path.join('uploads', `compressed_${Date.now()}.wav`);
    // Compress the uploaded audio to 16kHz mono WAV
    await compressAudio(req.file.path, compressedPath);
    // Use compressed file for transcription
    const audioStream = fs.createReadStream(compressedPath);
    const transcription = await groq.audio.transcriptions.create({
      file: audioStream,
      model: 'whisper-large-v3',
      language: 'id',
      response_format: 'verbose_json'
    });
    console.log('[Transcribe] Success! Text:', transcription.text);
    // Cleanup temp files (original and compressed)
    fs.unlinkSync(req.file.path);
    fs.unlinkSync(compressedPath);
    // Forward transcribed text to chat processing
    const userId = 'user_default';
    const chatResponse = await processMessage(userId, transcription.text);
    res.json({ transcription: transcription.text, response: chatResponse });






    // Helper: Generate receipt
    function generateReceipt(cart, isPaid = false, orderNumber = null) {
      if (!cart || cart.length === 0) {
        return 'Keranjang belanja Anda masih kosong. Mohon lakukan pesanan terlebih dahulu. 🛒';
      }

      const total = calculateTotal(cart);
      let receipt = isPaid ? '✅ PEMBAYARAN BERHASIL\n\n' : '📋 NOTA PESANAN\n\n';

      if (isPaid && orderNumber) {
        receipt += `No. Pesanan: #${orderNumber}\n`;
        receipt += `Tanggal: ${new Date().toLocaleString('id-ID', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })}\n\n`;
      }

      receipt += 'Barang:\n';
      cart.forEach(item => {
        const emoji = item.product === 'buku' ? '📚' :
          item.product === 'pensil' ? '✏️' :
            item.product === 'laptop' ? '💻' : '📦';
        receipt += `${emoji} ${item.quantity}x ${item.product.charAt(0).toUpperCase() + item.product.slice(1)} @ ${formatRupiah(item.price)} = ${formatRupiah(item.subtotal)}\n`;
      });

      receipt += '─────────────────────────\n';
      receipt += `TOTAL: ${formatRupiah(total)}\n\n`;

      if (isPaid) {
        receipt += 'Status: LUNAS ✅\n\n';
        receipt += 'Terima kasih atas pesanan Anda! 🙏';
      } else {
        receipt += 'Apakah pesanan sudah benar?\n';
        receipt += 'Silakan ketik "iya" untuk konfirmasi atau\n';
        receipt += '"tambah [jumlah] [item]" untuk menambah pesanan';
      }

      return receipt;
    }

    // Helper: Clear cart
    function clearCart(userId) {
      const session = getSession(userId);
      session.cart = [];
      session.awaitingConfirmation = false;
      session.orderNumber = null;
    }

    // Helper: Fuzzy string matching (for typo tolerance)
    function fuzzyMatch(str1, str2, threshold = 2) {
      // Simple Levenshtein distance
      const s1 = str1.toLowerCase();
      const s2 = str2.toLowerCase();

      if (s1 === s2) return true;
      if (Math.abs(s1.length - s2.length) > threshold) return false;

      const matrix = [];
      for (let i = 0; i <= s2.length; i++) {
        matrix[i] = [i];
      }
      for (let j = 0; j <= s1.length; j++) {
        matrix[0][j] = j;
      }

      for (let i = 1; i <= s2.length; i++) {
        for (let j = 1; j <= s1.length; j++) {
          if (s2.charAt(i - 1) === s1.charAt(j - 1)) {
            matrix[i][j] = matrix[i - 1][j - 1];
          } else {
            matrix[i][j] = Math.min(
              matrix[i - 1][j - 1] + 1,
              matrix[i][j - 1] + 1,
              matrix[i - 1][j] + 1
            );
          }
        }
      }

      return matrix[s2.length][s1.length] <= threshold;
    }

    // Helper: Check if message matches any keyword with typo tolerance
    function matchesKeyword(message, keywords, threshold = 2) {
      const words = message.split(' ');
      return keywords.some(keyword =>
        words.some(word => fuzzyMatch(word, keyword, threshold))
      );
    }

    // Function to check stock from MCP A
    async function checkStock(item) {
      try {
        console.log(`Memeriksa stok untuk: ${item}`);
        const url = `${MCP_A_URL}/api/v1/stock?item=${encodeURIComponent(item)}`;
        console.log('Mengakses URL MCP A:', url);

        // Pastikan MCP A berjalan
        const response = await axios.get(url, {
          timeout: 5000, // Timeout 5 detik
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          validateStatus: function (status) {
            return status >= 200 && status < 500; // Terima semua response code di bawah 500
          }
        });

        console.log('Response status dari MCP A:', response.status);
        console.log('Response data dari MCP A:', response.data);

        console.log('Response dari MCP A:', response.data);
        return response.data;
      } catch (error) {
        console.error('Error checking stock:', {
          message: error.message,
          response: error.response?.data,
          status: error.response?.status,
          url: error.config?.url
        });
        return {
          status: 'error',
          message: `Gagal memeriksa stok: ${error.message}`
        };
      }
    }

    // Function to create order using MCP B
    async function createOrder(orderData) {
      try {
        console.log('Membuat pesanan baru:', orderData);
        const url = `${MCP_B_URL}/api/v1/new-order`;
        console.log('Mengakses URL:', url);

        const response = await axios.post(url, orderData, {
          timeout: 5000, // Timeout 5 detik
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        });

        console.log('Response dari MCP B:', response.data);
        return response.data;
      } catch (error) {
        console.error('Error creating order:', {
          message: error.message,
          response: error.response?.data,
          status: error.response?.status,
          url: error.config?.url,
          data: error.config?.data
        });
        return {
          status: 'error',
          message: `Gagal membuat pesanan: ${error.message}`
        };
      }
    }

    // Chatbot endpoint
    app.post('/api/chat', async (req, res) => {
      try {
        const { message } = req.body;

        if (!message || message.trim() === '') {
          return res.status(400).json({ error: 'Pesan tidak boleh kosong' });
        }

        console.log('Menerima pesan:', message);

        // Preprocess message for better understanding
        const processedMessage = message.toLowerCase().trim();

        // Generate simple userId (in production, use proper auth)
        // Using IP or session token would be better
        const userId = 'user_default'; // Simplified for demo
        const session = getSession(userId);

        // ============================================
        // CONFIRMATION HANDLER (with typo tolerance)
        // ============================================
        const confirmKeywords = ['iya', 'ya', 'ok', 'oke', 'confirm', 'benar', 'betul', 'lanjut', 'setuju', 'yes', 'yup', 'sip'];
        const isConfirmation = (matchesKeyword(processedMessage, confirmKeywords, 2) ||
          confirmKeywords.some(keyword => processedMessage === keyword || processedMessage.includes(keyword))) &&
          processedMessage.split(' ').length <= 3;

        if (isConfirmation && session.awaitingConfirmation && session.cart.length > 0) {
          // Process all items in cart
          const orderNumber = 'ORD-' + Date.now();
          session.orderNumber = orderNumber;

          // Send each item to MCP B
          for (const item of session.cart) {
            await createOrder({
              product: item.product,
              quantity: item.quantity,
              customer: 'Pelanggan',
              date: new Date().toISOString()
            });
          }

          // Generate paid receipt
          const paidReceipt = generateReceipt(session.cart, true, orderNumber);

          // Add to conversation history
          addToConversationHistory(userId, 'user', message);
          addToConversationHistory(userId, 'assistant', paidReceipt);

          // Clear cart after successful order
          clearCart(userId);

          return res.json({ response: paidReceipt });
        }

        // ============================================
        // VIEW CART / TOTAL HANDLER
        // ============================================
        const cartKeywords = ['total', 'keranjang', 'pesanan', 'lihat pesanan', 'cek pesanan', 'nota'];
        const isViewCart = cartKeywords.some(keyword => processedMessage.includes(keyword)) &&
          !processedMessage.includes('stok') &&
          processedMessage.split(' ').length <= 4;

        if (isViewCart && session.cart.length > 0) {
          const receipt = generateReceipt(session.cart, false);
          session.awaitingConfirmation = true;

          // Add to conversation history
          addToConversationHistory(userId, 'user', message);
          addToConversationHistory(userId, 'assistant', receipt);

          return res.json({ response: receipt });
        } else if (isViewCart && session.cart.length === 0) {
          const emptyCartMsg = 'Keranjang belanja Anda masih kosong. Mohon lakukan pesanan terlebih dahulu. 🛒\n\nContoh: "Pesan 2 buku"';

          addToConversationHistory(userId, 'user', message);
          addToConversationHistory(userId, 'assistant', emptyCartMsg);

          return res.json({ response: emptyCartMsg });
        }

        // ============================================
        // CANCEL HANDLER
        // ============================================
        const cancelKeywords = ['batal', 'cancel', 'hapus pesanan', 'kosongkan', 'reset'];
        const isCancel = cancelKeywords.some(keyword => processedMessage.includes(keyword));

        if (isCancel && session.cart.length > 0) {
          const cancelMsg = 'Pesanan telah dibatalkan. Keranjang belanja dikosongkan. ❌\n\nSilakan mulai pesanan baru.';

          addToConversationHistory(userId, 'user', message);
          addToConversationHistory(userId, 'assistant', cancelMsg);

          clearCart(userId);
          return res.json({ response: cancelMsg });
        }

        // ============================================
        // PRODUCT CATALOG INQUIRY (MOVED TO TOP PRIORITY)
        // ============================================
        // Handle "apa saja produk yang tersedia", "produk apa", "list produk", etc.
        console.log('Checking catalog query for message:', processedMessage);

        const catalogKeywords = [
          'produk apa', 'apa saja', 'yang tersedia',
          'list produk', 'daftar produk', 'katalog',
          'produk tersedia', 'barang apa', 'jualan apa',
          'apa produk', 'produk yang ada'
        ];

        // Specific product names to exclude (if user asking about specific product, not catalog)
        const specificProducts = ['buku', 'pensil', 'laptop'];
        const mentionsSpecificProduct = specificProducts.some(prod => processedMessage.includes(prod));

        // Check for catalog query patterns (but NOT if asking about specific product with number)
        const hasNumber = /\d+/.test(processedMessage);
        const isCatalogQuery = !mentionsSpecificProduct && !hasNumber && (
          catalogKeywords.some(phrase => processedMessage.includes(phrase)) ||
          (processedMessage.includes('produk') && (processedMessage.includes('apa') || processedMessage.includes('tersedia') || processedMessage.includes('ada'))) ||
          (processedMessage.includes('barang') && (processedMessage.includes('apa') || processedMessage.includes('tersedia') || processedMessage.includes('ada'))) ||
          (processedMessage.includes('apa') && processedMessage.includes('saja'))
        );

        console.log('isCatalogQuery:', isCatalogQuery, 'mentionsSpecificProduct:', mentionsSpecificProduct, 'hasNumber:', hasNumber);

        // Exclude if asking about stock (should be handled by stock query handler)
        const isAskingAboutStock = processedMessage.includes('stok') ||
          processedMessage.includes('sisa') ||
          processedMessage.includes('jumlah');

        if (isCatalogQuery && !session.awaitingConfirmation && !isAskingAboutStock) {
          console.log('✅ CATALOG QUERY MATCHED!');
          const catalogResponse = `Kami memiliki 3 produk unggulan: ✨\n\n📚 Buku - Rp 30.000/unit\n✏️ Pensil - Rp 4.000/unit\n💻 Laptop - Rp 7.500.000/unit\n\nProduk mana yang ingin Anda pesan?`;

          // Add to conversation history
          addToConversationHistory(userId, 'user', message);
          addToConversationHistory(userId, 'assistant', catalogResponse);

          return res.json({
            response: catalogResponse
          });
        }

        // ============================================
        // PRICE INQUIRY HANDLER
        // ============================================
        const priceKeywords = ['harga', 'berapa', 'price', 'biaya', 'bayar'];
        const isPriceQuery = priceKeywords.some(keyword => processedMessage.includes(keyword)) &&
          !processedMessage.includes('total') &&  // Not cart total query
          !processedMessage.includes('stok') &&   // Not stock query
          !processedMessage.includes('sisa') &&   // Not stock query
          !processedMessage.includes('jumlah');   // Not stock query

        if (isPriceQuery) {
          // Try to find product mentioned
          const productNames = ['buku', 'pensil', 'laptop'];
          const mentionedProduct = productNames.find(prod => processedMessage.includes(prod));

          if (mentionedProduct) {
            const stockInfo = await checkStock(mentionedProduct);

            if (stockInfo.status === 'success') {
              const emoji = mentionedProduct === 'buku' ? '📚' :
                mentionedProduct === 'pensil' ? '✏️' : '💻';

              const priceResponse = `${emoji} Harga ${mentionedProduct.charAt(0).toUpperCase() + mentionedProduct.slice(1)} adalah ${formatRupiah(stockInfo.price)} per unit.\n\nApakah Anda ingin memesan? Silakan sebutkan jumlah yang diinginkan.`;

              addToConversationHistory(userId, 'user', message);
              addToConversationHistory(userId, 'assistant', priceResponse);

              return res.json({ response: priceResponse });
            } else {
              const notAvailableResponse = `Maaf, ${mentionedProduct} sedang tidak tersedia. Produk lain yang tersedia:\n📚 Buku - ${formatRupiah(30000)}/unit\n✏️ Pensil - ${formatRupiah(4000)}/unit\n💻 Laptop - ${formatRupiah(7500000)}/unit`;

              addToConversationHistory(userId, 'user', message);
              addToConversationHistory(userId, 'assistant', notAvailableResponse);

              return res.json({ response: notAvailableResponse });
            }
          } else {
            // No specific product, show all prices
            const allPricesResponse = `📋 Daftar Harga Produk Kami:\n\n📚 Buku - ${formatRupiah(30000)} per unit\n✏️ Pensil - ${formatRupiah(4000)} per unit\n💻 Laptop - ${formatRupiah(7500000)} per unit\n\nProduk mana yang ingin Anda pesan?`;

            addToConversationHistory(userId, 'user', message);
            addToConversationHistory(userId, 'assistant', allPricesResponse);

            return res.json({ response: allPricesResponse });
          }
        }



        // ============================================
        // STOCK QUERY HANDLER
        // ============================================
        // Check if the message is about checking stock
        const stockKeywords = ['stok', 'ada', 'berapa', 'sisa', 'tersedia', 'jumlah'];
        const isStockQuery = stockKeywords.some(keyword => processedMessage.includes(keyword)) ||
          /(cek|lihat|tampilkan|info)\s+(stok|barang|produk)/i.test(processedMessage);

        if (isStockQuery) {
          console.log('📦 Stock query detected, checking type...');

          // Check if asking for specific product
          const hasSpecificProduct = processedMessage.includes('buku') ||
            processedMessage.includes('pensil') ||
            processedMessage.includes('laptop');

          // Check if asking for ALL products stock
          // This includes: "berapa stok barang", "stok semua", "total stok", etc.
          const allStockKeywords = ['semua', 'setiap', 'seluruh', 'total', 'all', 'barang'];
          const hasAllStockKeyword = allStockKeywords.some(kw => processedMessage.includes(kw));

          // If no specific product mentioned AND has general stock keywords, show all stock
          const isAllStockQuery = !hasSpecificProduct && hasAllStockKeyword;

          console.log('hasSpecificProduct:', hasSpecificProduct);
          console.log('hasAllStockKeyword:', hasAllStockKeyword);
          console.log('isAllStockQuery:', isAllStockQuery);

          if (isAllStockQuery) {
            console.log('✅ ALL STOCK QUERY MATCHED!');

            // Fetch stock for all products
            const products = ['buku', 'pensil', 'laptop'];
            const stockData = [];

            for (const product of products) {
              const stockInfo = await checkStock(product);
              if (stockInfo.status === 'success') {
                stockData.push({
                  name: product,
                  stock: stockInfo.stock,
                  emoji: product === 'buku' ? '📚' : product === 'pensil' ? '✏️' : '💻'
                });
              }
            }

            // Generate response with stock per item AND total
            let stockResponse = 'Berikut stok produk kami:\n\n';
            let totalStock = 0;

            stockData.forEach(item => {
              stockResponse += `${item.emoji} ${item.name.charAt(0).toUpperCase() + item.name.slice(1)}: ${item.stock} unit\n`;
              totalStock += item.stock;
            });

            // Add total stock at the end
            stockResponse += `\n📊 Total Stok Keseluruhan: ${totalStock} unit\n`;
            stockResponse += '\nApakah Anda ingin melakukan pemesanan?';

            addToConversationHistory(userId, 'user', message);
            addToConversationHistory(userId, 'assistant', stockResponse);

            return res.json({ response: stockResponse });
          }

          // Extract item name for SPECIFIC product stock query
          const itemMatch = processedMessage.match(/(?:stok|jumlah|sisa|ada|berapa)\s*(?:dari|untuk|barang|produk)?\s*(?:yang |apa )?(?:yg )?(?:itu |ada )?\s*([a-zA-Z0-9]+)/i) ||
            processedMessage.match(/([a-zA-Z0-9]+)\s*(?:stok|tersedia|ada|jumlah)/i);

          const item = itemMatch ? itemMatch[1] || itemMatch[2] : null;

          if (item) {
            const stockInfo = await checkStock(item);
            if (stockInfo.status === 'success') {
              const stockResponse = `Stok ${stockInfo.item} saat ini tersedia ${stockInfo.stock} unit.`;

              addToConversationHistory(userId, 'user', message);
              addToConversationHistory(userId, 'assistant', stockResponse);

              return res.json({ response: stockResponse });
            } else {
              const notFoundResponse = `Mohon maaf, stok ${item} tidak dapat ditemukan.`;

              addToConversationHistory(userId, 'user', message);
              addToConversationHistory(userId, 'assistant', notFoundResponse);

              return res.json({ response: notFoundResponse });
            }
          }
        }

        // ============================================
        // PRODUCT INQUIRY HANDLER (e.g., "pesan pensil" without quantity)
        // ============================================
        const productNames = ['buku', 'pensil', 'laptop'];
        const inquiryKeywords = ['ada', 'pesan', 'beli', 'mau', 'order'];

        // Check if asking about product availability without specifying quantity
        const hasInquiryKeyword = inquiryKeywords.some(kw => processedMessage.includes(kw));
        const mentionedProduct = productNames.find(prod => processedMessage.includes(prod));
        const hasNumberInQuery = /\d+/.test(processedMessage);

        if (hasInquiryKeyword && mentionedProduct && !hasNumberInQuery) {
          // User asking "pesan pensil" or "ada buku" without quantity
          const stockInfo = await checkStock(mentionedProduct);

          if (stockInfo.status === 'success') {
            const emoji = mentionedProduct === 'buku' ? '📚' :
              mentionedProduct === 'pensil' ? '✏️' : '💻';

            const responses = [
              `Tersedia. ${emoji} ${mentionedProduct.charAt(0).toUpperCase() + mentionedProduct.slice(1)} tersedia dengan harga ${formatRupiah(stockInfo.price)} per unit.\n\nStok tersedia: ${stockInfo.stock} unit. Berapa unit yang ingin Anda pesan?\n\nContoh: "Pesan 5 ${mentionedProduct}"`,

              `${emoji} ${mentionedProduct.charAt(0).toUpperCase() + mentionedProduct.slice(1)} tersedia.\n\nHarga: ${formatRupiah(stockInfo.price)}/unit\nStok: ${stockInfo.stock} unit tersedia ✅\n\nBerapa unit yang ingin Anda pesan?`,

              `Baik. Kami memiliki ${emoji} ${mentionedProduct}.\n\n💰 Harga: ${formatRupiah(stockInfo.price)} per unit\n📦 Stok: ${stockInfo.stock} unit tersedia\n\nBerapa unit yang ingin Anda pesan? 🛒`,

              `Tersedia. ${emoji}\n\n${mentionedProduct.charAt(0).toUpperCase() + mentionedProduct.slice(1)} - ${formatRupiah(stockInfo.price)}/unit\nStok tersedia: ${stockInfo.stock} unit\n\nBerapa unit yang Anda perlukan? Contoh: "Pesan 3 ${mentionedProduct}"`
            ];

            return res.json({
              response: responses[Math.floor(Math.random() * responses.length)]
            });
          } else {
            return res.json({
              response: `Mohon maaf, ${mentionedProduct} sedang tidak tersedia.\n\nProduk yang tersedia:\n📚 Buku\n✏️ Pensil\n💻 Laptop\n\nApakah Anda ingin melihat produk lain?`
            });
          }
        }


        // ============================================
        // ORDER HANDLER
        // ============================================
        // Check if the message is about creating an order
        const orderKeywords = ['pesan', 'order', 'beli', 'mau', 'ingin', 'membeli', 'memesan'];
        const isOrderQuery = orderKeywords.some(keyword => processedMessage.includes(keyword)) ||
          /(saya|aku|gue|gw|kami|kita)\s+(mau|ingin|pengen|pengin|mohon|minta|butuh|perlu)/i.test(processedMessage);

        if (isOrderQuery) {
          // ============================================
          // MULTI-ITEM ORDER PARSER
          // ============================================
          // Parse multiple items: "buku 7 pensil 8 laptop 1"
          // Pattern: [product] [number] or [number] [product]

          const productNames = ['buku', 'pensil', 'laptop'];
          const foundItems = [];

          // Try to find all product-quantity pairs
          for (const product of productNames) {
            // Check if product mentioned
            if (processedMessage.includes(product)) {
              // Look for number before or after product name
              // Pattern 1: "buku 7" or "buku 7 unit"
              const afterMatch = processedMessage.match(new RegExp(`${product}\\s+(\\d+)`, 'i'));
              // Pattern 2: "7 buku"
              const beforeMatch = processedMessage.match(new RegExp(`(\\d+)\\s+${product}`, 'i'));

              if (afterMatch || beforeMatch) {
                const quantity = parseInt(afterMatch ? afterMatch[1] : beforeMatch[1]);
                foundItems.push({ product, quantity });
              }
            }
          }

          // If items found, process them
          if (foundItems.length > 0) {
            let allStockAvailable = true;
            let stockErrors = [];

            // Validate all items first
            for (const item of foundItems) {
              const stockInfo = await checkStock(item.product);

              if (stockInfo.status !== 'success') {
                stockErrors.push(`${item.product} tidak tersedia`);
                allStockAvailable = false;
              } else if (stockInfo.stock < item.quantity) {
                stockErrors.push(`Stok ${item.product} hanya ${stockInfo.stock} unit (diminta ${item.quantity})`);
                allStockAvailable = false;
              } else {
                // Store price info for later
                item.price = stockInfo.price;
              }
            }

            // If any stock issues, report them
            if (!allStockAvailable) {
              return res.json({
                response: `Maaf, ada masalah dengan stok:\n\n${stockErrors.join('\n')}\n\nSilakan coba lagi dengan jumlah yang tersedia.`
              });
            }

            // All items valid, add to cart
            for (const item of foundItems) {
              addToCart(userId, {
                product: item.product,
                quantity: item.quantity,
                price: item.price,
                subtotal: item.quantity * item.price
              });
            }

            // Set awaiting confirmation
            session.awaitingConfirmation = true;

            // Generate receipt
            const receipt = generateReceipt(session.cart, false);

            return res.json({ response: receipt });
          }

          // If no items found with quantity, try old pattern for backward compatibility
          const orderMatch = processedMessage.match(/(?:saya|aku|gue|gw|kami|kita)?\s*(?:mau|ingin|pengen|pengin|mohon|minta|butuh|perlu|tambah)?\s*(?:memesan|membeli|order|pesan|beli)?\s*(\d+)?\s*(?:unit|buah|pcs|pack|dus|box|\*?\s*)?\s*([a-zA-Z0-9]+)/i) ||
            processedMessage.match(/(\d+)\s*(?:unit|buah|pcs|pack|dus|box|\*?\s*)?\s*([a-zA-Z0-9]+)/i);

          if (orderMatch && (orderMatch[1] || orderMatch[2])) {
            const quantity = orderMatch[1] && !isNaN(orderMatch[1]) ? parseInt(orderMatch[1]) :
              orderMatch[2] && !isNaN(orderMatch[2]) ? parseInt(orderMatch[2]) : 1;
            const product = isNaN(orderMatch[1]) ? orderMatch[1] : orderMatch[2];

            if (!product || product.length < 2) {
              return res.json({
                response: 'Mohon maaf, mohon sebutkan produk yang ingin dipesan dengan format: "Pesan 2 buku"'
              });
            }

            // Check stock and get price
            const stockInfo = await checkStock(product);

            if (stockInfo.status !== 'success') {
              return res.json({
                response: `Maaf, produk "${product}" tidak tersedia. Produk yang tersedia: 📚 Buku, ✏️ Pensil, 💻 Laptop`
              });
            }

            if (stockInfo.stock < quantity) {
              return res.json({
                response: `Maaf, stok ${product} tidak mencukupi. Stok tersedia hanya ${stockInfo.stock} unit.`
              });
            }

            // Add to cart
            addToCart(userId, {
              product: product,
              quantity: quantity,
              price: stockInfo.price,
              subtotal: quantity * stockInfo.price
            });

            // Set awaiting confirmation
            session.awaitingConfirmation = true;

            // Generate receipt
            const receipt = generateReceipt(session.cart, false);

            return res.json({ response: receipt });
          }
        }

        // Quick response for common greetings
        const greetingKeywords = ['halo', 'hai', 'hello', 'hi', 'allo', 'hola', 'hey', 'selamat', 'hallo'];
        const isGreeting = greetingKeywords.some(keyword => processedMessage.includes(keyword)) &&
          processedMessage.split(' ').length <= 5; // Short messages only

        if (isGreeting && !isStockQuery && !isOrderQuery) {
          const greetingResponses = [
            'Selamat datang di toko kami! ✨\n\nKami memiliki berbagai produk berkualitas yang siap memenuhi kebutuhan Anda.\n\nApakah Anda ingin mengetahui produk yang tersedia atau langsung melakukan pemesanan? Saya siap membantu Anda. 🛍️',

            'Selamat datang! Terima kasih telah mengunjungi toko kami. 🎉\n\nKami menyediakan produk-produk pilihan dengan harga terbaik.\n\nAda yang bisa saya bantu? Anda dapat melihat produk atau langsung melakukan pemesanan.',

            'Selamat datang! 👋\n\nTerima kasih telah mengunjungi toko kami. Kami memiliki berbagai produk berkualitas untuk kebutuhan Anda.\n\nSilakan tanyakan informasi produk yang Anda butuhkan atau langsung lakukan pemesanan. 🛒',

            'Selamat datang! 🌟\n\nKami siap membantu Anda menemukan produk yang tepat dengan harga terbaik.\n\nApakah Anda ingin melihat katalog produk kami atau sudah memiliki produk yang ingin dipesan?',

            'Selamat datang! Senang dapat melayani Anda. 🎊\n\nToko kami menyediakan produk berkualitas dengan pelayanan terbaik.\n\nApa yang dapat saya bantu hari ini? Cek stok, informasi harga, atau langsung melakukan pemesanan?'
          ];

          const greetingMsg = greetingResponses[Math.floor(Math.random() * greetingResponses.length)];

          addToConversationHistory(userId, 'user', message);
          addToConversationHistory(userId, 'assistant', greetingMsg);

          return res.json({ response: greetingMsg });
        }

        if (!process.env.GROQ_API_KEY) {
          return res.json({
            response: 'Halo! Anda bisa: 1) Cek stok: "Cek stok buku/pensil/laptop" 2) Buat pesanan: "Pesan 2 buku".'
          });
        }

        // If no specific command is matched, use Groq for general conversation
        const systemPrompt = `Anda adalah asisten toko inventaris yang profesional, sopan, dan membantu. 
          Nama Anda adalah "Asisten Inventaris" dan Anda bekerja untuk toko yang menjual barang seperti buku, pensil, dan laptop.
          
          Kemampuan Anda:
          1. Memeriksa stok barang (buku, pensil, laptop, dll)
          2. Mencatat pesanan baru untuk pelanggan
          3. Menjawab pertanyaan umum dengan sopan
          4. Memahami typo dan kesalahan ketik dari pelanggan
          
          Cara berkomunikasi:
          - Gunakan bahasa Indonesia yang formal, sopan, dan profesional
          - Hindari bahasa kasual seperti "kak", "dong", "kok", "aja", "gimana", "mau", "yuk"
          - Gunakan "Anda" bukan "kamu" atau "kak"
          - Tambahkan emoji sesekali untuk membuat percakapan lebih ramah (😊, 👍, ✨)
          - Berikan jawaban singkat tapi informatif (maksimal 2-3 kalimat)
          - Jika pelanggan bertanya hal umum, jawab dengan sopan dan arahkan ke layanan Anda
          - Bersikap profesional namun tetap ramah
          - PENTING: Jika ada typo atau kesalahan ketik, coba pahami maksudnya dan jawab dengan sopan
          - Jika benar-benar tidak mengerti, minta klarifikasi dengan sopan
          - PENTING: Anda memiliki memori percakapan, gunakan konteks dari pesan sebelumnya untuk memberikan respons yang relevan
          
          Handling Typo:
          - "yanv" → pahami sebagai "yang"
          - "pnsel" → pahami sebagai "pensil"
          - "bukk" → pahami sebagai "buku"
          - "brpa" → pahami sebagai "berapa"
          - Inferensi maksud user dari konteks
          
          Contoh:
          - "Halo!" → "Selamat datang! Ada yang dapat saya bantu? 😊"
          - "Apa kabar?" → "Saya baik, terima kasih. Semoga Anda juga dalam keadaan baik. Ada yang dapat saya bantu?"
          - "Terima kasih" → "Sama-sama! Senang dapat membantu. Silakan hubungi kami kembali jika memerlukan bantuan."
          - "brpa hrga buku?" → "Harga buku kami Rp 30.000 per unit."
          - "adakah laptp?" → "Laptop tersedia dengan harga Rp 7.500.000. Apakah Anda ingin memesan? 💻"`;

        // Add current user message to history
        addToConversationHistory(userId, 'user', message);

        // Get conversation messages including history
        const conversationMessages = getConversationMessages(userId, systemPrompt);

        const completion = await groq.chat.completions.create({
          messages: conversationMessages,
          model: "llama-3.3-70b-versatile",  // Using more capable model
          temperature: 0.8,  // More creative
          max_tokens: 200
        });

        // Get the AI response
        let botResponse = completion.choices[0]?.message?.content || '';

        // If AI couldn't understand, provide helpful fallback
        if (!botResponse || botResponse.length < 10) {
          const helpfulResponses = [
            'Mohon maaf, saya kurang memahami maksud Anda.\n\nSilakan coba:\n• "Cek stok buku" - untuk melihat stok\n• "Pesan 2 pensil" - untuk pemesanan\n• "Total berapa?" - untuk melihat keranjang\n\nAtau tanyakan informasi yang Anda perlukan, saya siap membantu.',

            'Mohon maaf, saya belum memahami maksud Anda. 🤔\n\nUntuk melayani Anda lebih baik, silakan:\n✓ Tanyakan stok produk\n✓ Lakukan pemesanan\n✓ Tanyakan harga produk\n\nAda yang dapat saya bantu?',

            'Mohon maaf, sepertinya ada kesalahan pengetikan atau saya yang kurang memahami.\n\nSaya dapat membantu:\n📦 Cek ketersediaan barang\n🛒 Proses pesanan\n💰 Informasi harga\n\nSilakan coba lagi. Saya siap membantu Anda.'
          ];
          botResponse = helpfulResponses[Math.floor(Math.random() * helpfulResponses.length)];
        }

        // Make the response more natural
        const greetings = ['Halo!', 'Hai!', 'Halo, ada yang bisa saya bantu?'];
        const randomGreeting = greetings[Math.floor(Math.random() * greetings.length)];

        // If the response is too short, add a greeting
        if (botResponse.split(' ').length < 10 && !botResponse.includes('?') && !botResponse.includes('!') && !botResponse.includes('.')) {
          botResponse = `${randomGreeting} ${botResponse}`;
        }

        // Add bot response to conversation history
        addToConversationHistory(userId, 'assistant', botResponse);

        res.json({ response: botResponse });

      } catch (error) {
        console.error('Error in chat endpoint:', error);
        res.status(500).json({ error: 'Terjadi kesalahan saat memproses permintaan Anda.' });
      }
    });

    // ============================================
    // VOICE TRANSCRIPTION ENDPOINT (Groq Whisper)
    // ============================================
    app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
      try {
        console.log('[Transcribe] Request received');

        if (!req.file) {
          console.error('[Transcribe] No audio file uploaded');
          return res.status(400).json({ error: 'No audio file provided' });
        }

        console.log('[Transcribe] File:', req.file.filename, 'Size:', req.file.size, 'Type:', req.file.mimetype);
        console.log('[Transcribe] File path:', req.file.path);
        console.log('[Transcribe] Original name:', req.file.originalname);

        // Check if GROQ_API_KEY is set
        if (!process.env.GROQ_API_KEY) {
          console.error('[Transcribe] GROQ_API_KEY not set!');
          fs.unlinkSync(req.file.path);
          return res.status(500).json({ error: 'Server configuration error' });
        }

        console.log('[Transcribe] API Key present:', process.env.GROQ_API_KEY ? 'Yes' : 'No');
        console.log('[Transcribe] Sending to Groq Whisper API...');

        try {
          // Use createReadStream for Groq SDK in Node.js
          const audioStream = fs.createReadStream(req.file.path);

          // Transcribe with Groq Whisper
          const transcription = await groq.audio.transcriptions.create({
            file: audioStream,
            model: 'whisper-large-v3',
            language: 'id', // Indonesian
            response_format: 'verbose_json' // Get more details
          });

          console.log('[Transcribe] Raw response:', JSON.stringify(transcription, null, 2));
          console.log('[Transcribe] Success! Text:', transcription.text);

          // Cleanup temp file
          fs.unlinkSync(req.file.path);

          // Forward transcribed text to chat processing
          const userId = 'user_default';
          const chatResponse = await processMessage(userId, transcription.text);
          res.json({ response: chatResponse });

        } catch (groqError) {
          console.error('[Transcribe] Groq API Error Details:', {
            message: groqError.message,
            status: groqError.status,
            statusText: groqError.statusText,
            code: groqError.code,
            type: groqError.type,
            error: groqError.error
          });

          // Cleanup
          if (fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
          }

          res.status(500).json({
            error: 'Transcription API failed',
            details: groqError.message,
            statusCode: groqError.status
          });
        }

      } catch (error) {
        console.error('[Transcribe] General Error:', {
          message: error.message,
          stack: error.stack
        });

        // Cleanup temp file on error
        if (req.file && fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }

        res.status(500).json({
          error: 'Transcription failed',
          message: error.message
        });
      }
    });

    // Start the server
    app.listen(PORT, () => {
      console.log(`Chatbot service running on port ${PORT}`);
      console.log(`MCP A (Query) at ${MCP_A_URL}`);
      console.log(`MCP B (Modify) at ${MCP_B_URL}`);
    });
