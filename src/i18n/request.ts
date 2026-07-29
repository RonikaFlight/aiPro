import { getRequestConfig } from 'next-intl/server'
import { cookies } from 'next/headers'

export default getRequestConfig(async () => {
  const cookieStore = await cookies()
  const locale = cookieStore.get('proofpilot_locale')?.value || 'en'

  // Validate locale
  const validLocales = ['en', 'fa']
  const validatedLocale = validLocales.includes(locale) ? locale : 'en'

  return {
    locale: validatedLocale,
    messages: (await import(`../../messages/${validatedLocale}.json`)).default,
  }
})
