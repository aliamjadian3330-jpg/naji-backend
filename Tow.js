const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const towSchema = new mongoose.Schema({
  fullname: { type: String, required: true },
  birthdate: { type: String, required: true },
  nationalId: { type: String, required: true, unique: true },
  towType: { type: String },
  towModel: { type: String },
  plateNumber: { type: String },
  phone: { type: String },
  password: { type: String, required: true }
});

// هش کردن رمز قبل از ذخیره
towSchema.pre("save", async function(next){
  if(this.isModified("password")){
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  }
  next();
});

// متد بررسی رمز
towSchema.methods.matchPassword = async function(enteredPassword){
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model("Tow", towSchema);
