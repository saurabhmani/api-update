import { NextResponse } from 'next/server';
export async function POST(request: Request) {
    const data = await request.formData();
    const email = String(data.get('email') || '');
    const summary = String(data.get('summary') || '');
    if (!/^\S+@\S+\.\S+$/.test(email) || summary.trim().length < 4 || !data.get('consent'))
        return NextResponse.json({ error: 'Invalid submission' }, { status: 400 });
    return NextResponse.json({ accepted: true }, { status: 202 });
}
