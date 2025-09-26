const mongoose = require('mongoose');

const DriverSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  birthDate: { type: String, required: true },
  nationalId: { type: String, required: true, unique: true },
  licensePlate: { type: String, required: true },
  phone: { type: String, required: true },
  carType: { type: String, required: true },
  carColor: { type: String, required: true },
  carModel: { type: String, required: true },
  password: { type: String, required: true }
}, { timestamps: true });

module.exports = mongoose.model('Driver', DriverSchema);
