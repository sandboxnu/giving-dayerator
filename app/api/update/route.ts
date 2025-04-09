import { parse } from "node-html-parser";
import { type NextRequest } from "next/server";
import { createClient } from "redis";

interface combinedAmount {
  index: number;
  name: string;
  amount: string;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", {
      status: 401,
    });
  }

  // ===== Get the info =====
  const page = await fetch(
    "https://givingday.northeastern.edu/campaigns/sandbox-club",
    {},
  ).then((r) => r.text());

  const p = parse(page);

  const items = p.querySelectorAll(".fb-message");

  const combined: combinedAmount[] = [];
  for (const item of items) {
    const name = item.querySelector(".fb-user-name")?.text;
    const amount = item.querySelector(".donation-amount")?.text;

    const cleanedName = name ? name.trim() : "Secret";
    const cleanedAmount = amount ? amount.trim().substring(2) : "Secret";

    combined.push({
      index: items.length - items.indexOf(item),
      name: cleanedName,
      amount: cleanedAmount,
    });
  }

  // ===== find the new ones =====
  const client = createClient({
    url: process.env.REDIS_URL ?? "",
  });

  client.on("error", (err) => console.log("Redis Client Error", err));

  await client.connect();

  try {
    const missingRecords: combinedAmount[] = [];

    for (const record of combined) {
      const exists = await client.exists(`record:${record.index}`);

      if (!exists) {
        missingRecords.push(record);
      }
    }

    console.log(`${missingRecords.length} new donors!`);

    // ===== add the rest to redis =====
    for (const record of missingRecords) {
      await client.hSet(`record:${record.index}`, "name", record.name);
      await client.hSet(`record:${record.index}`, "amount", record.amount);
    }

    // sort so multiple records at the same time appear correctly
    missingRecords.sort((a, b) => a.index - b.index);

    // ===== hit the slack webhook for the new ones =====
    for (const record of missingRecords) {
      const body = {
        blocks: [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: "Somebody donated!",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "That makes " + String(record.index) + "!",
            },
          },
          {
            type: "section",
            fields: [
              {
                type: "mrkdwn",
                text: "*Name*\n" + record.name,
              },
              {
                type: "mrkdwn",
                text: "*Donation*\n" + record.amount,
              },
            ],
          },
        ],
      };

      await fetch(process.env.SLACK_WEBHOOK ?? "", {
        method: "POST",
        body: JSON.stringify(body),
      }).catch(() => console.log("failed to send slack update :("));
    }
  } finally {
    await client.disconnect();
  }

  return Response.json({ success: true });
}
