const express = require('express');
const router = express.Router();
const Driver = require('../models/Driver');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// ثبت‌نام راننده
router.post('/signup', async (req, res) => {
    try {
        const { fullName, birthDate, nationalId, licensePlate, phone, carType, carColor, carModel, password } = req.body;

        // بررسی اینکه راننده قبلا ثبت نشده باشد
        const existingDriver = await Driver.findOne({ nationalId });
        if(existingDriver) return res.status(400).json({ message: 'راننده قبلا ثبت شده است!' });

        // هش کردن رمز عبور
        const hashedPassword = await bcrypt.hash(password, 10);

        const newDriver = new Driver({
            fullName, birthDate, nationalId, licensePlate, phone, carType, carColor, carModel, password: hashedPassword
        });

        await newDriver.save();

        res.status(201).json({ message: 'ثبت‌نام موفقیت‌آمیز بود!' });

    } catch(err) {
        console.error(err);
        res.status(500).json({ message: 'خطای سرور' });
    }
});

// ورود راننده
router.post('/login', async (req, res) => {
    try {
        const { nationalId, password } = req.body;

        const driver = await Driver.findOne({ nationalId });
        if(!driver) return res.status(400).json({ message: 'کد ملی یا رمز عبور اشتباه است' });

        const isMatch = await bcrypt.compare(password, driver.password);
        if(!isMatch) return res.status(400).json({ message: 'کد ملی یا رمز عبور اشتباه است' });

        // تولید JWT
        const token = jwt.sign({ id: driver._id }, process.env.JWT_SECRET, { expiresIn: '7d' });

        res.json({ message: 'ورود موفقیت‌آمیز', token });

    } catch(err) {
        console.error(err);
        res.status(500).json({ message: 'خطای سرور' });
    }
});

// گرفتن اطلاعات راننده با JWT
router.get('/me', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if(!authHeader) return res.status(401).json({ message: 'توکن موجود نیست' });

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const driver = await Driver.findById(decoded.id).select('-password');
        if(!driver) return res.status(404).json({ message: 'راننده پیدا نشد' });

        res.json(driver);

    } catch(err) {
        console.error(err);
        res.status(401).json({ message: 'توکن نامعتبر' });
    }
});

module.exports = router;
