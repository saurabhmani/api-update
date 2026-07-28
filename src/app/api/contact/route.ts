import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

type ContactPayload = {
  name?: string;
  email?: string;
  subject?: string;
  message?: string;
  /** Honeypot — must stay empty. Obscure name avoids browser autofill. */
  q_hp?: string;
  /** @deprecated autofill-prone name; still rejected if present */
  website?: string;
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>'"]/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character,
  );

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ContactPayload;
    const name = body.name?.trim() ?? '';
    const email = body.email?.trim().toLowerCase() ?? '';
    const subject = body.subject?.trim() ?? '';
    const message = body.message?.trim() ?? '';
    const honeypot = (body.q_hp ?? body.website ?? '').trim();

    // Bots / autofilled honeypot: pretend success so scrapers get no signal
    if (honeypot) {
      return NextResponse.json({ success: true });
    }

    if (!name) {
      return NextResponse.json({ error: 'Please enter your name.' }, { status: 400 });
    }
    if (!emailPattern.test(email)) {
      return NextResponse.json({ error: 'Please enter a valid work email.' }, { status: 400 });
    }
    if (!subject) {
      return NextResponse.json({ error: 'Please enter a subject.' }, { status: 400 });
    }
    if (!message || message.length < 10) {
      return NextResponse.json(
        { error: 'Please enter a message of at least 10 characters.' },
        { status: 400 },
      );
    }

    const apiKey = process.env.MAILJET_API_KEY;
    const apiSecret = process.env.MAILJET_API_SECRET;
    const fromEmail = process.env.MAILJET_FROM_EMAIL;
    const recipientEmail = process.env.MAILJET_TO_EMAIL ?? fromEmail;

    if (!apiKey || !apiSecret || !fromEmail || !recipientEmail) {
      console.error('Mailjet contact form is missing server-side credentials.');
      return NextResponse.json({ error: 'The contact service is not configured.' }, { status: 503 });
    }

    const authorization = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
    const mailjetResponse = await fetch('https://api.mailjet.com/v3.1/send', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${authorization}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        Messages: [
          {
            From: { Email: fromEmail, Name: 'Quantorus Contact Form' },
            To: [{ Email: recipientEmail }],
            ReplyTo: { Email: email, Name: name },
            Subject: `Contact Form: ${subject}`,
            HTMLPart: `<h1>New Quantorus contact enquiry</h1><table><tr><th align="left">Name</th><td>${escapeHtml(name)}</td></tr><tr><th align="left">Email</th><td>${escapeHtml(email)}</td></tr><tr><th align="left">Subject</th><td>${escapeHtml(subject)}</td></tr></table><h2>Message</h2><p>${escapeHtml(message).replace(/\n/g, '<br />')}</p>`,
            TextPart: `Name: ${name}\nEmail: ${email}\nSubject: ${subject}\n\nMessage:\n${message}`,
          },
        ],
      }),
    });

    if (!mailjetResponse.ok) {
      const detail = await mailjetResponse.text().catch(() => '');
      console.error('Mailjet rejected contact form submission:', mailjetResponse.status, detail);
      return NextResponse.json(
        { error: 'We could not send your message. Please try again later.' },
        { status: 502 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Contact form submission failed:', error);
    return NextResponse.json(
      { error: 'We could not send your message. Please try again later.' },
      { status: 500 },
    );
  }
}
