require('dotenv').config(); // Load environment variables
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { google } = require("googleapis");
const nodemailer = require("nodemailer");

const app = express();
app.use(bodyParser.json());
app.use(cors());

// Set up Google Auth using environment variables
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID; // Replace with your spreadsheet ID from .env

// Function to get the current date in IST
const getISTDate = () => {
  const date = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000; // IST offset in milliseconds
  const istTime = new Date(date.getTime() + istOffset);
  return istTime.toISOString().split('T')[0];
};

// Set up Nodemailer transporter using environment variables
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// Function to send email
const sendEmail = (to, studentName, date) => {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: to,
    subject: 'Attendance Alert',
    text: `Dear Parent, your child ${studentName} was marked absent on ${date}. Please check their attendance.`,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error("Error sending email:", error);
    } else {
      console.log('Email sent:', info.response);
    }
  });
};

// User Login Endpoint
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  console.log("Login attempt:", username);

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  try {
    const client = await auth.getClient();
    const response = await sheets.spreadsheets.values.get({
      auth: client,
      spreadsheetId: SPREADSHEET_ID,
      range: "User!A:H", // Username, Password, ClassSheet1, ClassSheet2, ClassSheet3
    });

    const users = response.data.values || [];
    const user = users.find((row) => row[0] === username);

    if (user && user[1] === password) {
      console.log("Login successful for:", username);
      res.json({ 
        success: true, 
        user: { username: user[0], classSheets: [user[2], user[3], user[4], user[5], user[6], user[7], user[8]].filter(Boolean) } // Filter out empty values
      });
    } else {
      console.log("Invalid login for:", username);
      res.status(401).json({ error: "Invalid username or password" });
    }
  } catch (error) {
    console.error("Error during login:", error.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Fetch Class Data Endpoint
app.get("/attendance/:classSheet", async (req, res) => {
  const { classSheet } = req.params;

  if (!classSheet) {
    return res.status(400).json({ error: "ClassSheet is required" });
  }

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${classSheet}!A2:D`, // Adjusted to start from the second row
    });

    res.json({ success: true, data: response.data.values || [] });
  } catch (error) {
    console.error("Error fetching class data:", error.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Mark Attendance Endpoint
app.post("/attendance/mark", async (req, res) => {
  const { classSheet, attendance, user, date } = req.body;

  if (!classSheet || !attendance || !user || !date) {
    return res.status(400).json({
      error: "Missing required fields: classSheet, attendance, user, or date",
    });
  }

  try {
    const client = await auth.getClient();

    const currentDate = getISTDate();
    const headers = await getOrCreateColumnForDate(client, classSheet, currentDate);
    const currentColumn = headers.length - 1;  // Use the next column after the existing headers

    // Insert Date in the header row if it's not already present
    if (headers[headers.length - 1] !== currentDate) {
      await sheets.spreadsheets.values.update({
        auth: client,
        spreadsheetId: SPREADSHEET_ID,
        range: `${classSheet}!${String.fromCharCode(65 + currentColumn)}1`,
        valueInputOption: "USER_ENTERED",
        resource: {
          values: [[currentDate]],
        },
      });
    }

    const classDataResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${classSheet}!A2:D`, // Adjusted to start from the second row
    });

    const classData = classDataResponse.data.values || [];

    // Update Attendance
    const updates = attendance.map((item) => {
      const rowIndex = classData.findIndex((row) => row[0] === item.rollNumber); // Adjusted to match new headers
      if (rowIndex === -1) throw new Error(`Roll number ${item.rollNumber} not found.`);
      return {
        range: `${classSheet}!${String.fromCharCode(65 + currentColumn)}${rowIndex + 2}`, // Update attendance in the correct column, rowIndex + 2 to account for the header row
        values: [[item.status]], // "Present", "Absent"
      };
    });

    await sheets.spreadsheets.values.batchUpdate({
      auth: client,
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        data: updates,
        valueInputOption: "USER_ENTERED",
      },
    });

    // Log Attendance in Activity Sheet
    const activityLog = attendance.map((item) => {
      const student = classData.find((row) => row[0] === item.rollNumber); // Adjusted to match new headers
      if (item.status.toLowerCase() === 'absent') {
        // Send email if absent
        sendEmail(student[2], student[1], currentDate); // student[2] is Parent Email, student[1] is Student Name
      }
      return [
        currentDate,
        user,
        student[0], // Roll Number
        student[1], // Name of the Student
        student[3], // Section
        item.status,
      ];
    });

    await sheets.spreadsheets.values.append({
      auth: client,
      spreadsheetId: SPREADSHEET_ID,
      range: "Activity Sheet!A2:F", // Match with Activity Sheet columns and start from A2
      valueInputOption: "USER_ENTERED",
      resource: {
        values: activityLog,
      },
    });

    res.json({ success: true, message: "Attendance marked successfully!" });
  } catch (error) {
    console.error("Error marking attendance:", error.message);
    res.status(500).json({ error: "Failed to mark attendance" });
  }
});

// Helper function to get or create a column for the current date
const getOrCreateColumnForDate = async (client, classSheet, date) => {
  const response = await sheets.spreadsheets.values.get({
    auth: client,
    spreadsheetId: SPREADSHEET_ID,
    range: `${classSheet}!A1:Z1`, // Assuming the first row contains the dates
  });

  const headers = response.data.values[0] || [];
  let columnIndex = headers.indexOf(date);

  if (columnIndex === -1) {
    // Date not found, create a new column
    columnIndex = headers.length;
    headers.push(date);

    await sheets.spreadsheets.values.update({
      auth: client,
      spreadsheetId: SPREADSHEET_ID,
      range: `${classSheet}!A1:${String.fromCharCode(65 + columnIndex)}1`,
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [headers],
      },
    });
  }

  return headers; // Return updated headers array
};

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
