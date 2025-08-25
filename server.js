const express = require('express');
const nodemailer = require('nodemailer');
const multer = require('multer');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// إعدادات middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// إعدادات multer لرفع الملفات
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = './uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  // السماح بملفات PDF و TXT فقط
  if (file.mimetype === 'application/pdf' || file.mimetype === 'text/plain') {
    cb(null, true);
  } else {
    cb(new Error('نوع الملف غير مدعوم. يُسمح فقط بملفات PDF و TXT'), false);
  }
};

const upload = multer({ 
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB كحد أقصى
  }
});

// متغيرات لحفظ حالة الإرسال
let currentSendingStatus = {
  isRunning: false,
  total: 0,
  sent: 0,
  failed: 0,
  currentEmail: '',
  logs: [],
  shouldStop: false
};

let sendingInterval = null;

// دالة لإضافة سجل جديد
function addLog(type, message) {
  const timestamp = new Date().toLocaleString('ar-EG');
  const logEntry = {
    type: type,
    message: message,
    timestamp: timestamp
  };
  currentSendingStatus.logs.push(logEntry);
  
  // الاحتفاظ بآخر 100 سجل فقط
  if (currentSendingStatus.logs.length > 100) {
    currentSendingStatus.logs.shift();
  }
  
  console.log(`[${type.toUpperCase()}] ${message}`);
}

// دالة للتحقق من صحة الإيميل
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// دالة إنشاء transporter للـ SMTP - محدثة ومُصلحة
function createTransporter(smtpConfig) {
  console.log('إنشاء SMTP transporter:', {
    host: smtpConfig.host,
    port: smtpConfig.port,
    email: smtpConfig.email.substring(0, 5) + '***' // إخفاء جزء من الإيميل في السجل
  });

  // إعدادات مختلفة حسب نوع الخادم
  let transporterConfig = {
    host: smtpConfig.host,
    port: parseInt(smtpConfig.port) || 587,
    secure: false, // true للمنفذ 465، false للمنافذ الأخرى
    auth: {
      user: smtpConfig.email,
      pass: smtpConfig.password
    },
    pool: true, // استخدام connection pool
    maxConnections: 1, // اتصال واحد فقط في نفس الوقت
    maxMessages: 100, // عدد الرسائل لكل اتصال
    rateDelta: 1000, // فترة زمنية بين الرسائل (1 ثانية)
    rateLimit: 1, // رسالة واحدة لكل rateDelta
    connectionTimeout: 60000, // 60 seconds
    greetingTimeout: 30000, // 30 seconds
    socketTimeout: 60000, // 60 seconds
  };

  // إعدادات خاصة لكل خدمة
  if (smtpConfig.host.includes('gmail')) {
    transporterConfig.service = 'gmail';
    transporterConfig.tls = {
      rejectUnauthorized: false
    };
  } else if (smtpConfig.host.includes('yahoo')) {
    transporterConfig.service = 'yahoo';
    transporterConfig.tls = {
      rejectUnauthorized: false
    };
  } else if (smtpConfig.host.includes('outlook') || smtpConfig.host.includes('hotmail')) {
    transporterConfig.service = 'hotmail';
    transporterConfig.tls = {
      rejectUnauthorized: false
    };
  } else {
    // إعدادات عامة للخوادم المخصصة
    transporterConfig.tls = {
      rejectUnauthorized: false,
      ciphers: 'SSLv3'
    };
  }

  // تحديد secure حسب المنفذ
  if (parseInt(smtpConfig.port) === 465) {
    transporterConfig.secure = true;
  } else if (parseInt(smtpConfig.port) === 587 || parseInt(smtpConfig.port) === 25) {
    transporterConfig.secure = false;
  }

  try {
    const transporter = nodemailer.createTransport(transporterConfig);
    console.log('تم إنشاء transporter بنجاح');
    return transporter;
  } catch (error) {
    console.error('خطأ في إنشاء transporter:', error);
    throw error;
  }
}

// دالة مساعدة للتأخير
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// صفحة الموقع الرئيسية
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// رفع ملف الإيميلات
app.post('/upload-emails', upload.single('emailFile'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        message: 'لم يتم رفع أي ملف' 
      });
    }

    const filePath = req.file.path;
    const fileContent = fs.readFileSync(filePath, 'utf8');
    
    // استخراج الإيميلات من الملف
    const emails = fileContent.split(/[\n\r]+/)
      .map(email => email.trim())
      .filter(email => email && isValidEmail(email));

    // إزالة المكررات
    const uniqueEmails = [...new Set(emails)];

    // حذف الملف المؤقت
    fs.unlinkSync(filePath);

    addLog('info', `تم تحميل ${uniqueEmails.length} إيميل صحيح من الملف`);

    res.json({
      success: true,
      emails: uniqueEmails,
      count: uniqueEmails.length,
      message: `تم تحميل ${uniqueEmails.length} إيميل بنجاح`
    });

  } catch (error) {
    console.error('خطأ في رفع ملف الإيميلات:', error);
    addLog('error', `خطأ في معالجة الملف: ${error.message}`);
    res.status(500).json({
      success: false,
      message: 'خطأ في معالجة الملف'
    });
  }
});

// رفع ملف PDF
app.post('/upload-pdf', upload.single('pdfFile'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        message: 'لم يتم رفع أي ملف PDF' 
      });
    }

    addLog('info', `تم رفع ملف PDF: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)} MB)`);

    res.json({
      success: true,
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
      path: req.file.path,
      message: `تم رفع ملف PDF بنجاح: ${req.file.originalname}`
    });

  } catch (error) {
    console.error('خطأ في رفع ملف PDF:', error);
    addLog('error', `خطأ في رفع PDF: ${error.message}`);
    res.status(500).json({
      success: false,
      message: 'خطأ في رفع ملف PDF'
    });
  }
});

// بدء عملية إرسال الإيميلات
app.post('/send-emails', async (req, res) => {
  try {
    if (currentSendingStatus.isRunning) {
      return res.status(400).json({
        success: false,
        message: 'عملية إرسال أخرى قيد التنفيذ'
      });
    }

    const {
      smtpConfig,
      emailContent,
      emailList,
      pdfAttachment
    } = req.body;

    // التحقق من البيانات المطلوبة
    if (!smtpConfig || !emailContent || !emailList || emailList.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'بيانات غير كاملة'
      });
    }

    // التحقق من صحة إعدادات SMTP
    if (!smtpConfig.host || !smtpConfig.email || !smtpConfig.password) {
      return res.status(400).json({
        success: false,
        message: 'إعدادات SMTP غير مكتملة'
      });
    }

    // إعادة تهيئة حالة الإرسال
    currentSendingStatus = {
      isRunning: true,
      total: emailList.length,
      sent: 0,
      failed: 0,
      currentEmail: '',
      logs: [],
      shouldStop: false
    };

    addLog('info', `تم استلام طلب إرسال ${emailList.length} إيميل`);

    res.json({
      success: true,
      message: 'بدأت عملية الإرسال'
    });

    // بدء الإرسال في الخلفية
    sendEmailsInBackground(smtpConfig, emailContent, emailList, pdfAttachment);

  } catch (error) {
    console.error('خطأ في بدء الإرسال:', error);
    addLog('error', `خطأ في بدء العملية: ${error.message}`);
    res.status(500).json({
      success: false,
      message: 'خطأ في بدء عملية الإرسال'
    });
  }
});

// دالة إرسال الإيميلات في الخلفية - محدثة
async function sendEmailsInBackground(smtpConfig, emailContent, emailList, pdfAttachment) {
  addLog('info', `بدء إرسال ${emailList.length} إيميل`);
  addLog('info', `خادم SMTP: ${smtpConfig.host}:${smtpConfig.port}`);

  let transporter;
  
  try {
    // إنشاء transporter
    transporter = createTransporter(smtpConfig);

    // التحقق من الاتصال بـ SMTP مع معالجة أفضل للأخطاء
    addLog('info', 'جاري التحقق من الاتصال بخادم SMTP...');
    
    await new Promise((resolve, reject) => {
      transporter.verify((error, success) => {
        if (error) {
          reject(error);
        } else {
          resolve(success);
        }
      });
    });
    
    addLog('success', 'تم الاتصال بخادم SMTP بنجاح');
    
  } catch (error) {
    let errorMessage = 'فشل الاتصال بخادم SMTP';
    
    // رسائل خطأ أكثر وضوحاً
    if (error.code === 'EAUTH') {
      errorMessage = 'خطأ في المصادقة: تحقق من الإيميل وكلمة المرور';
    } else if (error.code === 'ECONNREFUSED') {
      errorMessage = 'رفض الاتصال: تحقق من عنوان الخادم والمنفذ';
    } else if (error.code === 'ETIMEDOUT') {
      errorMessage = 'انتهت مهلة الاتصال: تحقق من الاتصال بالإنترنت';
    } else if (error.message) {
      errorMessage = `خطأ في SMTP: ${error.message}`;
    }
    
    addLog('error', errorMessage);
    currentSendingStatus.isRunning = false;
    return;
  }

  // إعداد المرفق إذا كان موجوداً
  let attachments = [];
  if (pdfAttachment && pdfAttachment.path && fs.existsSync(pdfAttachment.path)) {
    attachments.push({
      filename: pdfAttachment.originalName,
      path: pdfAttachment.path
    });
    addLog('info', `تم إرفاق ملف PDF: ${pdfAttachment.originalName}`);
  }

  // إرسال الإيميلات واحداً تلو الآخر
  for (let i = 0; i < emailList.length; i++) {
    // التحقق من طلب الإيقاف
    if (currentSendingStatus.shouldStop) {
      addLog('info', 'تم إيقاف العملية بواسطة المستخدم');
      break;
    }

    const email = emailList[i];
    currentSendingStatus.currentEmail = email;

    addLog('info', `[${i + 1}/${emailList.length}] إرسال إلى: ${email}`);

    const mailOptions = {
      from: `"${emailContent.senderName || 'المرسل'}" <${smtpConfig.email}>`,
      to: email,
      subject: emailContent.subject,
      html: emailContent.body,
      attachments: attachments
    };

    try {
      const info = await transporter.sendMail(mailOptions);
      currentSendingStatus.sent++;
      addLog('success', `✅ تم الإرسال بنجاح إلى: ${email}`);
      
    } catch (error) {
      currentSendingStatus.failed++;
      let errorMsg = 'خطأ غير معروف';
      
      if (error.code === 'EMESSAGE') {
        errorMsg = 'خطأ في محتوى الرسالة';
      } else if (error.code === 'EENVELOPE') {
        errorMsg = 'خطأ في عنوان الإيميل';
      } else if (error.responseCode === 550) {
        errorMsg = 'عنوان الإيميل غير موجود';
      } else if (error.responseCode === 554) {
        errorMsg = 'رسالة مرفوضة من الخادم';
      } else if (error.message) {
        errorMsg = error.message;
      }
      
      addLog('error', `❌ فشل الإرسال إلى: ${email} - ${errorMsg}`);
    }

    // تأخير قصير لتجنب الحظر (Rate limiting)
    if (i < emailList.length - 1 && !currentSendingStatus.shouldStop) {
      await delay(2000); // تأخير 2 ثانية بين كل إيميل
    }
  }

  // إغلاق الاتصال
  try {
    if (transporter) {
      transporter.close();
      addLog('info', 'تم إغلاق الاتصال بخادم SMTP');
    }
  } catch (error) {
    console.error('خطأ في إغلاق الاتصال:', error);
  }

  // تنظيف الملفات المؤقتة
  if (pdfAttachment && pdfAttachment.path) {
    try {
      if (fs.existsSync(pdfAttachment.path)) {
        fs.unlinkSync(pdfAttachment.path);
        addLog('info', 'تم حذف الملف المؤقت');
      }
    } catch (error) {
      console.error('خطأ في حذف الملف المؤقت:', error);
    }
  }

  currentSendingStatus.isRunning = false;
  
  if (currentSendingStatus.shouldStop) {
    addLog('info', `🛑 تم إيقاف العملية! نجح: ${currentSendingStatus.sent}, فشل: ${currentSendingStatus.failed}`);
  } else {
    addLog('info', `🎉 انتهت عملية الإرسال! نجح: ${currentSendingStatus.sent}, فشل: ${currentSendingStatus.failed}`);
  }
}

// الحصول على حالة الإرسال الحالية
app.get('/sending-status', (req, res) => {
  res.json(currentSendingStatus);
});

// إيقاف عملية الإرسال
app.post('/stop-sending', (req, res) => {
  if (currentSendingStatus.isRunning) {
    currentSendingStatus.shouldStop = true;
    addLog('info', 'تم طلب إيقاف عملية الإرسال...');
    
    res.json({
      success: true,
      message: 'تم طلب إيقاف عملية الإرسال'
    });
  } else {
    res.json({
      success: false,
      message: 'لا توجد عملية إرسال قيد التنفيذ'
    });
  }
});

// اختبار إعدادات SMTP
app.post('/test-smtp', async (req, res) => {
  try {
    const { smtpConfig } = req.body;

    if (!smtpConfig || !smtpConfig.host || !smtpConfig.email || !smtpConfig.password) {
      return res.status(400).json({
        success: false,
        message: 'إعدادات SMTP غير مكتملة'
      });
    }

    const transporter = createTransporter(smtpConfig);
    
    // اختبار الاتصال مع timeout
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('انتهت مهلة الاتصال (30 ثانية)'));
      }, 30000);

      transporter.verify((error, success) => {
        clearTimeout(timeout);
        if (error) {
          reject(error);
        } else {
          resolve(success);
        }
      });
    });
    
    transporter.close();
    
    res.json({
      success: true,
      message: 'تم الاتصال بخادم SMTP بنجاح'
    });

  } catch (error) {
    console.error('خطأ في اختبار SMTP:', error);
    
    let errorMessage = 'فشل الاتصال بخادم SMTP';
    if (error.code === 'EAUTH') {
      errorMessage = 'خطأ في المصادقة: تحقق من الإيميل وكلمة المرور';
    } else if (error.code === 'ECONNREFUSED') {
      errorMessage = 'رفض الاتصال: تحقق من عنوان الخادم والمنفذ';
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    res.status(500).json({
      success: false,
      message: errorMessage
    });
  }
});

// إرسال إيميل تجريبي
app.post('/send-test-email', async (req, res) => {
  try {
    const { smtpConfig, emailContent, testEmail } = req.body;

    if (!testEmail || !isValidEmail(testEmail)) {
      return res.status(400).json({
        success: false,
        message: 'عنوان الإيميل التجريبي غير صحيح'
      });
    }

    const transporter = createTransporter(smtpConfig);

    const mailOptions = {
      from: `"${emailContent.senderName || 'المرسل'}" <${smtpConfig.email}>`,
      to: testEmail,
      subject: 'إيميل تجريبي - ' + (emailContent.subject || 'بدون موضوع'),
      html: `
        <div style="font-family: Arial, sans-serif; direction: rtl; text-align: right;">
          <h2>هذا إيميل تجريبي</h2>
          <p>تم إرسال هذا الإيميل للتأكد من صحة إعدادات SMTP.</p>
          <hr>
          <div style="background: #f5f5f5; padding: 15px; border-radius: 5px;">
            <h3>المحتوى الأصلي:</h3>
            ${emailContent.body || 'لا يوجد محتوى'}
          </div>
          <p style="color: #666; font-size: 12px; margin-top: 20px;">
            تم الإرسال في: ${new Date().toLocaleString('ar-EG')}
          </p>
        </div>
      `
    };

    const info = await transporter.sendMail(mailOptions);
    transporter.close();
    
    res.json({
      success: true,
      message: `تم إرسال الإيميل التجريبي بنجاح إلى: ${testEmail}`,
      messageId: info.messageId
    });

  } catch (error) {
    console.error('خطأ في إرسال الإيميل التجريبي:', error);
    res.status(500).json({
      success: false,
      message: `فشل إرسال الإيميل التجريبي: ${error.message}`
    });
  }
});

// مسح السجلات
app.post('/clear-logs', (req, res) => {
  currentSendingStatus.logs = [];
  addLog('info', 'تم مسح السجلات');
  
  res.json({
    success: true,
    message: 'تم مسح السجلات'
  });
});

// الحصول على معلومات الخادم
app.get('/server-info', (req, res) => {
  const info = {
    nodeVersion: process.version,
    platform: process.platform,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    serverTime: new Date().toLocaleString('ar-EG')
  };

  res.json({
    success: true,
    info: info
  });
});

// معالجة الأخطاء في رفع الملفات
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: 'حجم الملف كبير جداً. الحد الأقصى 10 ميجابايت'
      });
    }
  }
  
  if (error.message.includes('نوع الملف غير مدعوم')) {
    return res.status(400).json({
      success: false,
      message: error.message
    });
  }

  console.error('خطأ عام:', error);
  res.status(500).json({
    success: false,
    message: 'خطأ في الخادم'
  });
});

// معالجة المسارات غير الموجودة
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'الصفحة غير موجودة'
  });
});

// تشغيل الخادم
const server = app.listen(PORT, () => {
  console.log(`🚀 الخادم يعمل على المنفذ ${PORT}`);
  console.log(`🌐 افتح المتصفح على: http://localhost:${PORT}`);
  console.log(`📧 نظام إرسال الإيميلات جاهز للاستخدام`);
  addLog('info', `الخادم بدأ العمل على المنفذ ${PORT}`);
});

// التعامل مع إغلاق الخادم بشكل صحيح
process.on('SIGTERM', () => {
  console.log('🛑 إيقاف الخادم...');
  
  if (currentSendingStatus.isRunning) {
    currentSendingStatus.shouldStop = true;
    addLog('info', 'إيقاف عمليات الإرسال الجارية...');
  }

  server.close(() => {
    console.log('✅ تم إيقاف الخادم بنجاح');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n🛑 تم طلب إيقاف الخادم (Ctrl+C)');
  
  if (currentSendingStatus.isRunning) {
    currentSendingStatus.shouldStop = true;
    console.log('⏳ انتظار انتهاء عمليات الإرسال الجارية...');
    
    // انتظار لمدة 5 ثوان قبل الإغلاق القسري
    setTimeout(() => {
      console.log('⏰ انتهت مهلة الانتظار، إغلاق فوري');
      process.exit(0);
    }, 5000);
  } else {
    process.exit(0);
  }
});

// التعامل مع الأخطاء غير المتوقعة
process.on('uncaughtException', (error) => {
  console.error('خطأ غير متوقع:', error);
  addLog('error', `خطأ في النظام: ${error.message}`);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promise مرفوض:', promise, 'السبب:', reason);
  addLog('error', `خطأ في Promise: ${reason}`);
});

// تصدير التطبيق للاختبار
module.exports = app;
