import { cookies } from 'next/headers';
import { NextRequest } from 'next/server';

export async function getOrCreateUserId(request: NextRequest): Promise<string> {
  const cookieStore = await cookies();
  let userId = cookieStore.get('ai_news_user_id')?.value;

  if (!userId) {
    userId = crypto.randomUUID();
    cookieStore.set('ai_news_user_id', userId, {
      httpOnly: true,
      secure: request.nextUrl.protocol === 'https:',
      sameSite: 'lax',
      path: '/',
      maxAge: 31536000, // 1 year
    });
  }

  return userId;
}
