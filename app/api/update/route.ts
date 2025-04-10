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
    const newKeys = combined.map(
      (o) => `${o.name.substring(0, 50)}-${o.amount}`,
    );

    const oldKeys = await client.lRange("donations", 0, -1);

    console.log(newKeys);
    console.log(oldKeys);

    const newDonations = findUniqueElementsInB(oldKeys, newKeys);
    const newDonationObj = combined.slice(0, newDonations.length).toReversed();

    // ===== add the rest to redis =====
    for (const e of newDonationObj) {
      await client.lPush("donations", `${e.name.substring(0, 50)}-${e.amount}`);
    }

    console.log(newDonationObj);

    // ===== hit the slack webhook for the new ones =====
    for (const record of newDonationObj) {
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

function findUniqueElementsInB(a: string[], b: string[]) {
  const aCopy = [...a];

  const result = [];

  for (let i = 0; i < b.length; i++) {
    const matchIndex = aCopy.indexOf(b[i]);

    if (matchIndex === -1) {
      result.push(b[i]);
    } else {
      aCopy.splice(matchIndex, 1);
    }
  }

  return result;
}
