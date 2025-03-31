/**
 * FY'S INVESTMENT BOT
 *
 * FEATURES:
 *  • Displays the WhatsApp QR code on a simple Express webpage (http://localhost:3000)
 *  • Sends clear, single replies for every operation (deposit, invest, etc.)
 *    and instructs users to type “00” to view the main menu.
 *  • New admin commands:
 *       - admin addbalance <phone> <amount>
 *       - admin deductbalance <phone> <amount>
 *       - admin unban <phone>
 *  • All actions generate alert messages for both users and admins.
 *
 * NOTES:
 *  • Replace BOT_PHONE below with your bot’s number (digits only; e.g. "254700363422").
 *  • Super Admin is fixed at +254701339573.
 */

const { Client } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const express = require('express');
const qrcode = require('qrcode');

// -----------------------------------
// CONFIG & GLOBALS
// -----------------------------------

// The bot’s own WhatsApp number (digits only, no plus sign).
const BOT_PHONE = '254700363422'; 
const SUPER_ADMIN = '254701339573'; // Super Admin number

// Start with Super Admin in admin list.
let admins = [SUPER_ADMIN];

// User database file (JSON)
const USERS_FILE = path.join(__dirname, 'users.json');
// In-memory sessions for conversation state.
let sessions = {};

// Load users or initialize new object.
let users = {};
if (fs.existsSync(USERS_FILE)) {
  try {
    users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (e) {
    console.error('Error reading users file:', e);
    users = {};
  }
} else {
  users = {};
}
function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Helper: Kenya date/time in a friendly format.
function getKenyaTime() {
  return new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
}

// Helper: generate a random string.
function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
function generateReferralCode() {
  return "FY'S-" + randomString(5);
}
function generateDepositID() {
  return "DEP-" + randomString(8);
}
function generateWithdrawalID() {
  return "WD-" + randomString(4);
}
// Check if a chat belongs to an admin.
function isAdmin(chatId) {
  let cleanId = chatId.replace(/\D/g, '');
  return admins.includes(cleanId);
}
// Notify all admins.
async function notifyAdmins(text) {
  for (let adminPhone of admins) {
    const adminWID = `${adminPhone}@c.us`;
    try {
      await client.sendMessage(adminWID, text);
    } catch (error) {
      console.error(`Error notifying admin ${adminPhone}:`, error);
    }
  }
}

// -----------------------------------
// EXPRESS SERVER FOR QR CODE
// -----------------------------------
const app = express();
let lastQr = null;
app.get('/', (req, res) => {
  if (!lastQr) {
    return res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; margin-top: 50px;">
          <h1>FY'S INVESTMENT BOT</h1>
          <p>No QR code available yet. Please wait for the bot to generate one...</p>
        </body>
      </html>
    `);
  }
  qrcode.toDataURL(lastQr, (err, url) => {
    if (err) return res.send('Error generating QR code.');
    res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; margin-top: 50px;">
          <h1>FY'S INVESTMENT BOT - QR Code</h1>
          <img src="${url}" alt="WhatsApp QR Code"/>
          <p>Scan this code with your WhatsApp to log in!</p>
        </body>
      </html>
    `);
  });
});
app.listen(3000, () => {
  console.log('Express server running. Visit http://localhost:3000 to view the QR code.');
});

// -----------------------------------
// WHATSAPP CLIENT
// -----------------------------------
const client = new Client();
client.on('qr', (qr) => {
  console.log('New QR code generated. Open http://localhost:3000 to view it.');
  lastQr = qr;
});
client.on('ready', async () => {
  console.log(`✅ Client is ready! [${getKenyaTime()}]`);
  const superAdminWID = `${SUPER_ADMIN}@c.us`;
  try {
    await client.sendMessage(
      superAdminWID,
      `Hello Super Admin! 🎉\nFY'S INVESTMENT BOT is now connected.\n[${getKenyaTime()}]`
    );
  } catch (error) {
    console.error('Error sending message to Super Admin:', error);
  }
});

// -----------------------------------
// MESSAGE HANDLER
// -----------------------------------
client.on('message_create', async (message) => {
  // Ignore messages sent by the bot.
  if (message.fromMe) return;

  const chatId = message.from;
  const msgBody = message.body.trim();
  console.log(`[${getKenyaTime()}] Message from ${chatId}: ${msgBody}`);

  // Deposit status check: "DP status <DEP-ID>"
  if (/^dp status /i.test(msgBody)) {
    await handleDepositStatusRequest(message);
    return;
  }
  // Navigation: "00" shows main menu.
  if (msgBody === '00') {
    await message.reply(`🏠 *Main Menu*\nType the option number below:`);
    await message.reply(mainMenuText());
    sessions[chatId] = { state: 'awaiting_menu_selection' };
    return;
  }
  // Navigation: "0" to cancel current operation.
  if (msgBody === '0') {
    await message.reply(`🔙 Operation cancelled. Type "00" for Main Menu.`);
    sessions[chatId] = { state: 'awaiting_menu_selection' };
    return;
  }
  // Admin commands.
  if (msgBody.toLowerCase().startsWith('admin') && isAdmin(chatId)) {
    await processAdminCommand(message);
    return;
  }
  // Registration / user session.
  let registeredUser = Object.values(users).find(u => u.whatsAppId === chatId);
  if (!sessions[chatId]) {
    sessions[chatId] = { state: registeredUser ? 'awaiting_menu_selection' : 'start' };
  }
  let session = sessions[chatId];
  if (!registeredUser) {
    await handleRegistration(message, session);
  } else {
    if (registeredUser.banned) {
      await message.reply(`🚫 You have been banned from using this service.`);
      return;
    }
    await handleUserSession(message, session, registeredUser);
  }
});

// -----------------------------------
// DEPOSIT STATUS HANDLER
// -----------------------------------
async function handleDepositStatusRequest(message) {
  const chatId = message.from;
  const msgBody = message.body.trim();
  const parts = msgBody.split(' ');
  if (parts.length < 3) {
    await message.reply(`❓ Please specify the deposit ID. Example: *DP status DEP-ABCDEFGH*`);
    return;
  }
  const depositID = parts.slice(2).join(' ');
  let user = Object.values(users).find(u => u.whatsAppId === chatId);
  if (!user) {
    await message.reply(`You are not registered yet. Please register first.`);
    return;
  }
  let deposit = user.deposits.find(d => d.depositID.toLowerCase() === depositID.toLowerCase());
  if (!deposit) {
    await message.reply(`❌ No deposit found with ID: *${depositID}*`);
    return;
  }
  await message.reply(
    `📝 *Deposit Status*\n` +
    `• Deposit ID: ${deposit.depositID}\n` +
    `• Amount: Ksh ${deposit.amount}\n` +
    `• Date: ${deposit.date}\n` +
    `• Status: ${deposit.status}\n` +
    `[${getKenyaTime()}]\n` +
    `Type "00" for Main Menu.`
  );
}

// -----------------------------------
// REGISTRATION HANDLER
// -----------------------------------
async function handleRegistration(message, session) {
  const chatId = message.from;
  const msgBody = message.body.trim();
  switch (session.state) {
    case 'start':
      await message.reply(
        `👋 Welcome to *FY'S INVESTMENT BOT* 😊\n\n` +
        `Please enter your *first name* to get started.`
      );
      session.state = 'awaiting_first_name';
      break;
    case 'awaiting_first_name':
      session.firstName = msgBody;
      setTimeout(async () => {
        await message.reply(`Great, *${session.firstName}*!\nNow, enter your *second name*:`);
        session.state = 'awaiting_second_name';
      }, 2000);
      break;
    case 'awaiting_second_name':
      session.secondName = msgBody;
      await message.reply(
        `Thanks, *${session.firstName} ${session.secondName}*!\n` +
        `If you have a *referral code*, type it now; otherwise, type *NONE*.`
      );
      session.state = 'awaiting_referral_code';
      break;
    case 'awaiting_referral_code': {
      const code = msgBody.toUpperCase();
      if (code !== 'NONE') {
        let referrer = Object.values(users).find(u => u.referralCode === code);
        if (referrer) {
          session.referredBy = referrer.whatsAppId;
          await message.reply(`👍 Referral code accepted!\nNow, enter your phone number (start with 070 or 01, 10 digits).`);
        } else {
          await message.reply(`⚠️ Referral code not found. Continuing without referral.\nEnter your phone number (start with 070 or 01, 10 digits).`);
        }
      } else {
        await message.reply(`No referral code entered.\nEnter your phone number (start with 070 or 01, 10 digits).`);
      }
      session.state = 'awaiting_phone';
      break;
    }
    case 'awaiting_phone':
      if (!/^(07|01)[0-9]{8}$/.test(msgBody)) {
    await message.reply(`❌ Invalid format. Your number must start with 07 or 01 and be exactly 10 digits.\nRe-enter your phone number.`);
} else {
    session.phone = msgBody;
    await message.reply(`Now, create a *4-digit PIN* for withdrawals (from referral earnings).`);
    session.state = 'awaiting_withdrawal_pin';
      }
      break;
    case 'awaiting_withdrawal_pin':
      if (!/^\d{4}$/.test(msgBody)) {
        await message.reply(`❌ Invalid PIN. Enter a *4-digit* PIN:`);
      } else {
        session.withdrawalPIN = msgBody;
        await message.reply(`Almost done! Create a *4-digit security PIN* (used if you're inactive for 30 minutes).`);
        session.state = 'awaiting_security_pin';
      }
      break;
    case 'awaiting_security_pin':
      if (!/^\d{4}$/.test(msgBody)) {
        await message.reply(`❌ Invalid PIN. Enter a *4-digit* security PIN:`);
      } else {
        session.securityPIN = msgBody;
        // Create and save new user.
        const newUser = {
          whatsAppId: chatId,
          firstName: session.firstName,
          secondName: session.secondName,
          phone: session.phone,
          withdrawalPIN: session.withdrawalPIN,
          securityPIN: session.securityPIN,
          referralCode: generateReferralCode(),
          referredBy: session.referredBy || null,
          referrals: [],
          accountBalance: 0,
          referralEarnings: 0,
          investments: [],
          deposits: [],
          withdrawals: [],
          banned: false
        };
        users[session.phone] = newUser;
        saveUsers();
        await message.reply(
          `✅ Registration successful, *${newUser.firstName}*!\nYour referral code is: *${newUser.referralCode}*\n[${getKenyaTime()}]\n` +
          `Type "00" for Main Menu.`
        );
        sessions[chatId] = { state: 'awaiting_menu_selection' };
      }
      break;
    default:
      await message.reply(`Something went wrong. Let’s start over.\nType "00" for Main Menu.`);
      session.state = 'awaiting_menu_selection';
      break;
  }
}

// -----------------------------------
// USER SESSION HANDLER
// -----------------------------------
async function handleUserSession(message, session, user) {
  const chatId = message.from;
  const msgBody = message.body.trim();
  // Based on the current session state, process the input.
  switch (session.state) {
    case 'awaiting_menu_selection':
      // Process main menu options.
      switch (msgBody) {
        case '1': // Invest
          session.state = 'invest';
          await message.reply(`💰 Enter the *investment amount* (min Ksh 1,000; max Ksh 150,000):`);
          break;
        case '2': // Check Balance
          session.state = 'check_balance_menu';
          await message.reply(
            `🔍 Check Balance Options:\n1. Account Balance\n2. Referral Earnings\n3. Investment History\n` +
            `Reply with 1, 2, or 3:`
          );
          break;
        case '3': // Withdraw
          session.state = 'withdraw';
          await message.reply(`💸 Enter the amount to withdraw from your referral earnings (min Ksh 1,000):`);
          break;
        case '4': // Deposit
          session.state = 'deposit';
          await message.reply(`💵 Enter the deposit amount:`);
          break;
        case '5': // Change PIN
          session.state = 'change_pin';
          await message.reply(`🔑 Enter your current 4-digit PIN:`);
          break;
        case '6': // My Referral Link
          {
            // Generate WhatsApp referral link in the format:
            // https://wa.me/<BOT_PHONE>?text=REF<REFERRAL_CODE>
            const referralLink = `https://wa.me/${BOT_PHONE}?text=REF${encodeURIComponent(user.referralCode)}`;
            await message.reply(
              `🔗 *My Referral Link*\nShare this link:\n${referralLink}\n` +
              `When clicked, it opens a chat with the bot pre-filled with your referral code!\n` +
              `[${getKenyaTime()}]\nType "00" for Main Menu.`
            );
            session.state = 'awaiting_menu_selection';
          }
          break;
        default:
          await message.reply(`❓ Invalid option. Please type the option number.`);
          break;
      }
      break;
    case 'invest': {
      let amount = parseFloat(msgBody);
      if (isNaN(amount) || amount < 1000 || amount > 150000) {
        await message.reply(`❌ Enter an amount between Ksh 1,000 and Ksh 150,000:`);
      } else if (user.accountBalance < amount) {
        await message.reply(`⚠️ Insufficient balance (Ksh ${user.accountBalance}). Please deposit funds.\nType "00" for Main Menu.`);
        session.state = 'awaiting_menu_selection';
      } else {
        session.investAmount = amount;
        session.state = 'confirm_investment';
        await message.reply(`Please enter your 4-digit PIN to confirm investing Ksh ${amount}:`);
      }
      break;
    }
    case 'confirm_investment':
      if (msgBody !== user.withdrawalPIN) {
        await message.reply(`❌ Incorrect PIN. Try again or type "0" to cancel.`);
      } else {
        user.accountBalance -= session.investAmount;
        let investment = {
          amount: session.investAmount,
          date: getKenyaTime(),
          expectedReturn: (session.investAmount * 0.10).toFixed(2),
          status: 'active'
        };
        user.investments.push(investment);
        // Process referral bonus if applicable.
        if (user.investments.length === 1 && user.referredBy) {
          let referrer = Object.values(users).find(u => u.whatsAppId === user.referredBy);
          if (referrer) {
            let bonus = session.investAmount * 0.03;
            referrer.referralEarnings += bonus;
            referrer.referrals.push(user.phone);
            console.log(
              `📢 [${getKenyaTime()}] Referral bonus: ${referrer.firstName} earned Ksh ${bonus.toFixed(2)} from ${user.firstName}'s investment.`
            );
          }
        }
        saveUsers();
        await message.reply(
          `✅ Investment confirmed!\nAmount: Ksh ${session.investAmount}\nExpected Return: Ksh ${investment.expectedReturn}\nDate: ${getKenyaTime()}\nType "00" for Main Menu.`
        );
        session.state = 'awaiting_menu_selection';
        await notifyAdmins(
          `🔔 *Investment Alert*\nUser: ${user.firstName} ${user.secondName} (${user.phone})\nInvested: Ksh ${session.investAmount}\n[${getKenyaTime()}]`
        );
      }
      break;
    case 'check_balance_menu':
      switch (msgBody) {
        case '1':
          await message.reply(`💳 Account Balance: Ksh ${user.accountBalance}\n[${getKenyaTime()}]\nType "00" for Main Menu.`);
          session.state = 'awaiting_menu_selection';
          break;
        case '2':
          await message.reply(`🎉 Referral Earnings: Ksh ${user.referralEarnings}\n[${getKenyaTime()}]\nType "00" for Main Menu.`);
          session.state = 'awaiting_menu_selection';
          break;
        case '3':
          if (user.investments.length === 0) {
            await message.reply(`📄 No investments yet.\n[${getKenyaTime()}]\nType "00" for Main Menu.`);
          } else {
            let history = user.investments.map((inv, i) =>
              `${i + 1}. Amount: Ksh ${inv.amount}, Return: Ksh ${inv.expectedReturn}, Date: ${inv.date}, Status: ${inv.status}`
            ).join('\n');
            await message.reply(`📊 Investment History:\n${history}\n[${getKenyaTime()}]\nType "00" for Main Menu.`);
          }
          session.state = 'awaiting_menu_selection';
          break;
        default:
          await message.reply(`❓ Invalid option. Reply with 1, 2, or 3.`);
          break;
      }
      break;
    case 'withdraw': {
      let amount = parseFloat(msgBody);
      if (isNaN(amount) || amount < 1000) {
        await message.reply(`❌ Minimum withdrawal is Ksh 1,000. Enter a valid amount:`);
      } else if (user.referralEarnings < amount) {
        await message.reply(`⚠️ Insufficient referral earnings (Ksh ${user.referralEarnings}).\nType "00" for Main Menu.`);
        session.state = 'awaiting_menu_selection';
      } else {
        user.referralEarnings -= amount;
        let wd = {
          amount: amount,
          date: getKenyaTime(),
          withdrawalID: generateWithdrawalID(),
          status: 'pending'
        };
        user.withdrawals.push(wd);
        saveUsers();
        await message.reply(
          `✅ Withdrawal request received.\nWithdrawal ID: ${wd.withdrawalID}\nAmount: Ksh ${amount}\nStatus: Under review\n[${getKenyaTime()}]\nType "00" for Main Menu.`
        );
        session.state = 'awaiting_menu_selection';
        await notifyAdmins(
          `🔔 *Withdrawal Request*\nUser: ${user.firstName} ${user.secondName} (${user.phone})\nAmount: Ksh ${amount}\nWithdrawal ID: ${wd.withdrawalID}\n[${getKenyaTime()}]`
        );
      }
      break;
    }
    case 'deposit': {
      let amount = parseFloat(msgBody);
      if (isNaN(amount) || amount <= 0) {
        await message.reply(`❌ Enter a valid deposit amount:`);
      } else {
        let dep = {
          amount: amount,
          date: getKenyaTime(),
          depositID: generateDepositID(),
          status: 'under review'
        };
        user.deposits.push(dep);
        saveUsers();
        await message.reply(
          `💵 Deposit Request Received!\nDeposit ID: ${dep.depositID}\nAmount: Ksh ${amount}\nPayment to: M-Pesa 0701339573 (Name: Camlus Okoth)\nStatus: Under review\n[${getKenyaTime()}]\nType "00" for Main Menu.`
        );
        session.state = 'awaiting_menu_selection';
        await notifyAdmins(
          `🔔 *Deposit Request*\nUser: ${user.firstName} ${user.secondName} (${user.phone})\nAmount: Ksh ${amount}\nDeposit ID: ${dep.depositID}\n[${getKenyaTime()}]`
        );
      }
      break;
    }
    case 'change_pin':
      if (msgBody !== user.withdrawalPIN) {
        await message.reply(`❌ Incorrect PIN. Try again or type "0" to cancel.`);
      } else {
        session.state = 'new_pin';
        await message.reply(`🔑 Enter your new 4-digit PIN:`);
      }
      break;
    case 'new_pin':
      if (!/^\d{4}$/.test(msgBody)) {
        await message.reply(`❌ Invalid PIN. Enter a 4-digit PIN:`);
      } else {
        user.withdrawalPIN = msgBody;
        saveUsers();
        await message.reply(`✅ PIN changed successfully!\n[${getKenyaTime()}]\nType "00" for Main Menu.`);
        session.state = 'awaiting_menu_selection';
      }
      break;
    default:
      // If state is unrecognized, prompt main menu.
      await message.reply(`Type "00" for Main Menu.`);
      session.state = 'awaiting_menu_selection';
      break;
  }
}

// -----------------------------------
// ADMIN COMMAND PROCESSOR
// -----------------------------------
async function processAdminCommand(message) {
  const chatId = message.from;
  const msgParts = message.body.trim().split(' ');
  const command = (msgParts[1] || '').toLowerCase();
  const subCommand = (msgParts[2] || '').toLowerCase();

  // admin CMD: show available admin commands.
  if (command === 'cmd') {
    await message.reply(
      `⚙️ *ADMIN COMMANDS*\n\n` +
      `1. admin CMD\n   - Show this list.\n\n` +
      `2. admin view users\n   - List all registered users.\n\n` +
      `3. admin view investments\n   - List all investments.\n\n` +
      `4. admin view deposits\n   - List all deposits.\n\n` +
      `5. admin approve deposit <DEP-ID>\n   - Approve a deposit.\n\n` +
      `6. admin reject deposit <DEP-ID> <Reason>\n   - Reject a deposit with a reason.\n\n` +
      `7. admin approve withdrawal <WD-ID>\n   - Approve a withdrawal.\n\n` +
      `8. admin reject withdrawal <WD-ID> <Reason>\n   - Reject a withdrawal with a reason.\n\n` +
      `9. admin ban user <phone> <Reason>\n   - Ban a user by phone.\n\n` +
      `10. admin add admin <phone>\n   - Add a new admin (Super Admin only).\n\n` +
      `11. admin addbalance <phone> <amount>\n   - Add amount to user balance.\n\n` +
      `12. admin deductbalance <phone> <amount>\n   - Deduct amount from user balance.\n\n` +
      `13. admin unban <phone>\n   - Unban a user.\n\n` +
      `[${getKenyaTime()}]`
    );
    return;
  }

  // Existing admin commands (view, approve/reject, ban, add admin) …
  if (command === 'view' && subCommand === 'users') {
    let userList = Object.values(users)
      .map(u => `${u.firstName} ${u.secondName} (Phone: ${u.phone})`)
      .join('\n');
    if (!userList) userList = 'No registered users.';
    await message.reply(`📋 *User List:*\n\n${userList}\n\n[${getKenyaTime()}]`);
    return;
  }
  if (command === 'view' && subCommand === 'investments') {
    let investmentsList = '';
    for (let key in users) {
      let u = users[key];
      u.investments.forEach((inv, idx) => {
        investmentsList += `${u.firstName} ${u.secondName} - Investment ${idx + 1}: Ksh ${inv.amount}, Status: ${inv.status}\n`;
      });
    }
    if (!investmentsList) investmentsList = 'No investments found.';
    await message.reply(`📊 *All Investments:*\n\n${investmentsList}\n[${getKenyaTime()}]`);
    return;
  }
  if (command === 'view' && subCommand === 'deposits') {
    let depositsList = '';
    for (let key in users) {
      let u = users[key];
      u.deposits.forEach((dep, idx) => {
        depositsList += `${u.firstName} ${u.secondName} - Deposit ${idx + 1}: ID: ${dep.depositID}, Amount: Ksh ${dep.amount}, Status: ${dep.status}\n`;
      });
    }
    if (!depositsList) depositsList = 'No deposits found.';
    await message.reply(`💰 *All Deposits:*\n\n${depositsList}\n[${getKenyaTime()}]`);
    return;
  }
  if (command === 'approve' && subCommand === 'deposit') {
    const depID = msgParts[3];
    if (!depID) {
      await message.reply(`Usage: admin approve deposit <DEP-ID>`);
      return;
    }
    let found = false;
    for (let key in users) {
      let u = users[key];
      u.deposits.forEach(dep => {
        if (dep.depositID.toLowerCase() === depID.toLowerCase()) {
          dep.status = 'approved';
          u.accountBalance += parseFloat(dep.amount);
          found = true;
        }
      });
    }
    if (found) {
      saveUsers();
      await message.reply(`✅ Deposit ${depID} approved.\n[${getKenyaTime()}]`);
    } else {
      await message.reply(`❌ Deposit ID not found: ${depID}`);
    }
    return;
  }
  if (command === 'reject' && subCommand === 'deposit') {
    const depID = msgParts[3];
    if (!depID) {
      await message.reply(`Usage: admin reject deposit <DEP-ID> <Reason>`);
      return;
    }
    const reason = msgParts.slice(4).join(' ') || 'No reason given';
    let found = false;
    for (let key in users) {
      let u = users[key];
      u.deposits.forEach(dep => {
        if (dep.depositID.toLowerCase() === depID.toLowerCase()) {
          dep.status = `rejected (${reason})`;
          found = true;
        }
      });
    }
    if (found) {
      saveUsers();
      await message.reply(`❌ Deposit ${depID} rejected.\nReason: ${reason}\n[${getKenyaTime()}]`);
    } else {
      await message.reply(`Deposit ID not found: ${depID}`);
    }
    return;
  }
  if (command === 'approve' && subCommand === 'withdrawal') {
    const wdID = msgParts[3];
    if (!wdID) {
      await message.reply(`Usage: admin approve withdrawal <WD-ID>`);
      return;
    }
    let found = false;
    for (let key in users) {
      let u = users[key];
      u.withdrawals.forEach(wd => {
        if (wd.withdrawalID.toLowerCase() === wdID.toLowerCase()) {
          wd.status = 'approved';
          found = true;
        }
      });
    }
    if (found) {
      saveUsers();
      await message.reply(`✅ Withdrawal ${wdID} approved.\n[${getKenyaTime()}]`);
    } else {
      await message.reply(`❌ Withdrawal ID not found: ${wdID}`);
    }
    return;
  }
  if (command === 'reject' && subCommand === 'withdrawal') {
    const wdID = msgParts[3];
    if (!wdID) {
      await message.reply(`Usage: admin reject withdrawal <WD-ID> <Reason>`);
      return;
    }
    const reason = msgParts.slice(4).join(' ') || 'No reason given';
    let found = false;
    for (let key in users) {
      let u = users[key];
      u.withdrawals.forEach(wd => {
        if (wd.withdrawalID.toLowerCase() === wdID.toLowerCase()) {
          wd.status = `rejected (${reason})`;
          found = true;
        }
      });
    }
    if (found) {
      saveUsers();
      await message.reply(`❌ Withdrawal ${wdID} rejected.\nReason: ${reason}\n[${getKenyaTime()}]`);
    } else {
      await message.reply(`Withdrawal ID not found: ${wdID}`);
    }
    return;
  }
  if (command === 'ban' && subCommand === 'user') {
    let phone = msgParts[3];
    if (!phone) {
      await message.reply(`Usage: admin ban user <phone> <Reason>`);
      return;
    }
    let reason = msgParts.slice(4).join(' ') || 'No reason provided';
    if (users[phone]) {
      if (users[phone].whatsAppId.replace(/\D/g, '') === SUPER_ADMIN) {
        await message.reply(`🚫 Cannot ban the Super Admin.`);
        return;
      }
      users[phone].banned = true;
      saveUsers();
      await message.reply(`🚫 User ${phone} banned.\nReason: ${reason}\n[${getKenyaTime()}]`);
    } else {
      await message.reply(`User with phone ${phone} not found.`);
    }
    return;
  }
  if (command === 'add' && subCommand === 'admin') {
    if (chatId.replace(/\D/g, '') !== SUPER_ADMIN) {
      await message.reply(`🚫 Only the Super Admin can add new admins.`);
      return;
    }
    let newAdminPhone = msgParts[3]?.replace(/\D/g, '');
    if (!newAdminPhone) {
      await message.reply(`Usage: admin add admin <phone>`);
      return;
    }
    if (!admins.includes(newAdminPhone)) {
      admins.push(newAdminPhone);
      await message.reply(`✅ ${newAdminPhone} added as an admin.`);
    } else {
      await message.reply(`ℹ️ ${newAdminPhone} is already an admin.`);
    }
    return;
  }
  // NEW ADMIN COMMANDS:
  if (command === 'addbalance') {
    // Format: admin addbalance <phone> <amount>
    let phone = msgParts[2];
    let amount = parseFloat(msgParts[3]);
    if (!phone || isNaN(amount)) {
      await message.reply(`Usage: admin addbalance <phone> <amount>`);
      return;
    }
    if (!users[phone]) {
      await message.reply(`User with phone ${phone} not found.`);
      return;
    }
    users[phone].accountBalance += amount;
    saveUsers();
    await message.reply(`✅ Added Ksh ${amount} to user ${phone}. New balance: Ksh ${users[phone].accountBalance}`);
    const userWID = users[phone].whatsAppId;
    try {
      await client.sendMessage(userWID, `Your account has been credited with Ksh ${amount}. New balance: Ksh ${users[phone].accountBalance}`);
    } catch (error) {
      console.error(`Error notifying user ${phone}:`, error);
    }
    return;
  }
  if (command === 'deductbalance') {
    // Format: admin deductbalance <phone> <amount>
    let phone = msgParts[2];
    let amount = parseFloat(msgParts[3]);
    if (!phone || isNaN(amount)) {
      await message.reply(`Usage: admin deductbalance <phone> <amount>`);
      return;
    }
    if (!users[phone]) {
      await message.reply(`User with phone ${phone} not found.`);
      return;
    }
    users[phone].accountBalance = Math.max(0, users[phone].accountBalance - amount);
    saveUsers();
    await message.reply(`✅ Deducted Ksh ${amount} from user ${phone}. New balance: Ksh ${users[phone].accountBalance}`);
    const userWID = users[phone].whatsAppId;
    try {
      await client.sendMessage(userWID, `Ksh ${amount} has been deducted from your account. New balance: Ksh ${users[phone].accountBalance}`);
    } catch (error) {
      console.error(`Error notifying user ${phone}:`, error);
    }
    return;
  }
  if (command === 'unban') {
    // Format: admin unban <phone>
    let phone = msgParts[2];
    if (!phone) {
      await message.reply(`Usage: admin unban <phone>`);
      return;
    }
    if (!users[phone]) {
      await message.reply(`User with phone ${phone} not found.`);
      return;
    }
    users[phone].banned = false;
    saveUsers();
    await message.reply(`✅ User ${phone} has been unbanned.`);
    const userWID = users[phone].whatsAppId;
    try {
      await client.sendMessage(userWID, `You have been unbanned from FY'S INVESTMENT BOT.`);
    } catch (error) {
      console.error(`Error notifying user ${phone}:`, error);
    }
    return;
  }
  // If command not recognized:
  await message.reply(`❓ Unrecognized admin command. Type "admin CMD" to see all commands.\n[${getKenyaTime()}]`);
}

// -----------------------------------
// MAIN MENU HELPER (for reference)
// -----------------------------------
function mainMenuText() {
  return (
    `🌟 *FY'S INVESTMENT BOT Main Menu*\n` +
    `Options:\n` +
    `1. Invest 💰\n` +
    `2. Check Balance 🔍\n` +
    `3. Withdraw Earnings 💸\n` +
    `4. Deposit Funds 💵\n` +
    `5. Change PIN 🔑\n` +
    `6. My Referral Link 🔗\n\n` +
    `Type the option number or "00" to view this menu again.`
  );
}

// -----------------------------------
// START THE CLIENT
// -----------------------------------
client.initialize();
