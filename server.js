import express from "express";
import { Telegraf } from "telegraf";
import userModel from "./src/models/User.js";
import connectDb from "./src/config/db.js";
import { message } from "telegraf/filters";
import eventModel from "./src/models/Event.js";
import fetch from "node-fetch";
import dotenv from "dotenv";

// Load .env only when running locally
if (!process.env.BOT_TOKEN) {
  dotenv.config();
}

const app = express();
app.use(express.json());

// Telegram Bot Init
const bot = new Telegraf(process.env.BOT_TOKEN);

// Webhook path (Telegram will send updates here)
const WEBHOOK_PATH = "/telegram/webhook";

// Your Choreo domain (Added in Choreo ENV: WEBHOOK_URL)
const DOMAIN = process.env.WEBHOOK_URL;

// Set webhook only if DOMAIN exists
if (DOMAIN) {
  console.log("Setting webhook...");
  await bot.telegram.setWebhook(`${DOMAIN}${WEBHOOK_PATH}`);
}

// Register webhook with express
app.use(bot.webhookCallback(WEBHOOK_PATH));

/* ------------------------
   CONNECT DATABASE
------------------------ */
try {
  connectDb();
  console.log("MongoDB Connected");
} catch (err) {
  console.error("DB Connection ERROR:", err);
  process.exit(1);
}

/* ------------------------
       BOT COMMANDS
------------------------ */

// /start command
bot.start(async (ctx) => {
  const from = ctx.update.message.from;

  try {
    await userModel.findOneAndUpdate(
      { tgId: from.id },
      {
        $setOnInsert: {
          firstName: from.first_name,
          lastName: from.last_name,
          isBot: from.is_bot,
          username: from.username,
        },
      },
      { upsert: true }
    );

    await ctx.reply(
      `Hey! ${from.first_name}, Welcome. I will write highly engaging social media posts for you. Keep feeding me your events.`
    );
  } catch (err) {
    console.log(err);
    await ctx.reply("Something went wrong while saving your data.");
  }
});

// /generate command
bot.command("generate", async (ctx) => {
  const from = ctx.update.message.from;

  const { message_id: waitMsg } = await ctx.reply(
    `Hey! ${from.first_name}, Kindly wait a moment. I am curating posts for you`
  );

  const { message_id: stickerMsg } = await ctx.replyWithSticker(
    "CAACAgIAAxkBAAMUaSyLiRsrspRIkG1QS3gQYCit4ToAAl4SAALsmSlJfO_ZpUf3ZDs2BA"
  );

  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const events = await eventModel.find({
    tgId: from.id,
    createdAt: { $gte: start, $lte: end },
  });

  if (events.length === 0) {
    await ctx.deleteMessage(waitMsg);
    await ctx.deleteMessage(stickerMsg);
    return ctx.reply("No events found for the day.");
  }

  try {
    const promptText = `Write 3 engaging social media posts for LinkedIn, Facebook, and Twitter. Do not mention time. Use these events:\n${events
      .map((e) => "- " + e.text)
      .join("\n")}`;

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: process.env.GROQ_MODEL,
          messages: [
            { role: "system", content: "You are a senior copywriter." },
            { role: "user", content: promptText },
          ],
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error("GROQ API ERROR:", response.status, err);
      throw new Error("Groq error");
    }

    const data = await response.json();
    const aiText = data.choices?.[0]?.message?.content || "No response.";

    await ctx.deleteMessage(waitMsg);
    await ctx.deleteMessage(stickerMsg);

    await ctx.reply(aiText);
  } catch (err) {
    console.error("GROQ ERROR →", err);
    await ctx.reply("Failed to generate posts. Please try again later.");
  }
});

// Text listener (save events)
bot.on(message("text"), async (ctx) => {
  const from = ctx.update.message.from;
  const text = ctx.update.message.text;

  try {
    await eventModel.create({
      text,
      tgId: from.id,
    });

    await ctx.reply(
      "Noted. Keep texting me your thoughts. To generate posts, type /generate"
    );
  } catch (err) {
    console.log(err);
    await ctx.reply("Failed to save the event.");
  }
});

/* ------------------------
     START EXPRESS SERVER
------------------------ */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Telegram bot running on webhook mode at PORT:", PORT);
});
