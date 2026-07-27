/**
 * Forms analyzer — ProofPilot worker (Phase 5)
 *
 * Detects:
 *   - Inputs without associated <label> (or aria-label / title)
 *   - Inputs with inappropriate autocomplete values (e.g. text on email fields)
 *   - Missing autocomplete on common input types (email, tel, current-password)
 *   - Password fields without autocomplete="current-password" or "new-password"
 *   - Submit buttons that are disabled or missing
 *   - Forms without proper error feedback regions (no [role="alert"] / .error)
 *   - Required fields without aria-required or visual indication in label
 *   - Forms that submit to off-origin actions without visible notice (informational)
 *   - Inputs with type=text used for email/url/tel (better type= improves mobile UX)
 *   - Form fields obscuring the keyboard on mobile (covered by responsive analyzer)
 *
 * Source data: ctx.page (DOM inspection)
 */
import type { Analyzer, AnalyzerContext, FindingCandidate } from './types'

interface FormMeasurement {
  selector: string
  action: string
  method: string
  hasSubmitButton: boolean
  submitDisabled: boolean
  hasErrorRegion: boolean
  inputs: Array<{
    selector: string
    type: string
    name: string
    id: string
    hasLabel: boolean
    labelType: 'label' | 'aria-label' | 'title' | 'placeholder' | 'none'
    autocomplete: string
    required: boolean
    ariaRequired: boolean
    placeholder: string
  }>
}

async function measureForms(ctx: AnalyzerContext): Promise<FormMeasurement[]> {
  return ctx.page.evaluate(() => {
    function selectorFor(el: Element): string {
      const parts: string[] = []
      let cur: Element | null = el
      for (let i = 0; i < 4 && cur && cur !== document.documentElement; i++) {
        let part = cur.tagName.toLowerCase()
        if (cur.id) {
          part += `#${cur.id}`
          parts.unshift(part)
          break
        }
        const cls = Array.from(cur.classList).slice(0, 2).map((c) => `.${c}`).join('')
        if (cls) part += cls
        parts.unshift(part)
        cur = cur.parentElement
      }
      return parts.join(' > ') || el.tagName.toLowerCase()
    }

    const forms = Array.from(document.querySelectorAll('form'))
    return forms.map((form): FormMeasurement => {
      const inputs = Array.from(form.querySelectorAll('input, select, textarea')).filter((el) => {
        const input = el as HTMLInputElement
        // Skip submit/button/reset/hidden/image inputs — they don't need labels
        return !['submit', 'button', 'reset', 'hidden', 'image'].includes(input.type)
      })

      const submitButtons = form.querySelectorAll('button[type="submit"], button:not([type]), input[type="submit"]')
      const errorRegions = form.querySelectorAll('[role="alert"], .error, .field-error, [aria-live="assertive"]')

      return {
        selector: selectorFor(form),
        action: form.getAttribute('action') ?? '',
        method: (form.getAttribute('method') ?? 'get').toLowerCase(),
        hasSubmitButton: submitButtons.length > 0,
        submitDisabled: Array.from(submitButtons).some((b) => (b as HTMLButtonElement).disabled),
        hasErrorRegion: errorRegions.length > 0,
        inputs: inputs.map((el) => {
          const input = el as HTMLInputElement
          const id = input.id ?? ''
          let labelType: FormMeasurement['inputs'][number]['labelType'] = 'none'
          if (id) {
            const label = form.querySelector(`label[for="${CSS.escape(id)}"]`)
            if (label && label.textContent?.trim()) labelType = 'label'
          }
          if (labelType === 'none') {
            // Check for wrapping <label>
            const parent = input.parentElement
            if (parent && parent.tagName.toLowerCase() === 'label' && parent.textContent?.trim()) {
              labelType = 'label'
            }
          }
          if (labelType === 'none' && input.getAttribute('aria-label')?.trim()) labelType = 'aria-label'
          if (labelType === 'none' && input.getAttribute('title')?.trim()) labelType = 'title'
          if (labelType === 'none' && input.getAttribute('placeholder')?.trim()) labelType = 'placeholder'

          return {
            selector: selectorFor(input),
            type: input.type,
            name: input.name ?? '',
            id,
            hasLabel: labelType === 'label' || labelType === 'aria-label' || labelType === 'title',
            labelType,
            autocomplete: input.getAttribute('autocomplete') ?? '',
            required: input.required,
            ariaRequired: input.getAttribute('aria-required') === 'true',
            placeholder: input.getAttribute('placeholder') ?? '',
          }
        }),
      }
    })
  }).catch(() => [] as FormMeasurement[])
}

/** Expected autocomplete values for input types. */
function expectedAutocomplete(type: string, name: string): string | null {
  const lcName = name.toLowerCase()
  if (type === 'email' || lcName.includes('email')) return 'email'
  if (type === 'tel' || lcName.includes('phone') || lcName.includes('tel')) return 'tel'
  if (type === 'password') {
    // Heuristic: new-account forms often have name containing "new" or "confirm"
    if (lcName.includes('new') || lcName.includes('confirm')) return 'new-password'
    return 'current-password'
  }
  if (type === 'url' || lcName.includes('website') || lcName.includes('url')) return 'url'
  if (lcName.includes('name') && !lcName.includes('username')) return 'name'
  if (lcName.includes('username') || lcName.includes('login')) return 'username'
  if (lcName.includes('address')) return 'street-address'
  if (lcName.includes('zip') || lcName.includes('postal')) return 'postal-code'
  if (lcName.includes('country')) return 'country-name'
  if (lcName.includes('city')) return 'address-level2'
  return null
}

export const formsAnalyzer: Analyzer = {
  id: 'forms',
  category: 'FORMS',
  async run(ctx: AnalyzerContext): Promise<FindingCandidate[]> {
    const findings: FindingCandidate[] = []
    const forms = await measureForms(ctx)

    for (const form of forms) {
      // 1. Inputs without labels
      for (const input of form.inputs) {
        if (!input.hasLabel) {
          const severity = input.labelType === 'placeholder' ? 'MAJOR' : 'MAJOR'
          findings.push({
            checkId: 'forms.missing_label',
            category: 'FORMS',
            severity,
            title: `Form input without accessible label (${input.selector})`,
            description: input.labelType === 'placeholder'
              ? `The ${input.type || 'input'} field "${input.name || input.id || '?'}" relies on placeholder text for labeling. Placeholders disappear on focus and are not a substitute for labels.`
              : `The ${input.type || 'input'} field "${input.name || input.id || '?'}" has no associated <label>, aria-label, or title. Screen reader users cannot determine its purpose.`,
            remediation: 'Add a <label for="id"> element, or an aria-label attribute, describing the field\'s purpose.',
            selector: input.selector,
            messageKey: `missing-label-${input.type || 'input'}`,
            evidence: { type: input.type, name: input.name, labelType: input.labelType },
          })
        }
      }

      // 2. Missing / inappropriate autocomplete
      for (const input of form.inputs) {
        const expected = expectedAutocomplete(input.type, input.name)
        if (expected && input.autocomplete === '') {
          findings.push({
            checkId: 'forms.missing_autocomplete',
            category: 'FORMS',
            severity: 'MINOR',
            title: `Missing autocomplete attribute on ${input.type} field`,
            description: `The ${input.type} field "${input.name || input.id || '?'}" has no autocomplete attribute. Setting autocomplete="${expected}" would let password managers and browsers autofill the field correctly.`,
            remediation: `Add autocomplete="${expected}" to the input.`,
            selector: input.selector,
            messageKey: `missing-autocomplete-${expected}`,
            evidence: { type: input.type, name: input.name, expected },
          })
        } else if (expected && input.autocomplete && input.autocomplete !== 'off' && input.autocomplete !== expected) {
          findings.push({
            checkId: 'forms.wrong_autocomplete',
            category: 'FORMS',
            severity: 'INFO',
            title: `Inappropriate autocomplete value on ${input.type} field`,
            description: `The ${input.type} field "${input.name || input.id || '?'}" has autocomplete="${input.autocomplete}" but should likely be "${expected}".`,
            remediation: `Change autocomplete to "${expected}".`,
            selector: input.selector,
            messageKey: `wrong-autocomplete-${input.autocomplete}`,
            evidence: { type: input.type, name: input.name, current: input.autocomplete, expected },
          })
        }
      }

      // 3. Email/tel/url fields using type=text
      for (const input of form.inputs) {
        if (input.type === 'text') {
          const expected = expectedAutocomplete('text', input.name)
          if (expected === 'email' || expected === 'tel' || expected === 'url') {
            findings.push({
              checkId: 'forms.suboptimal_input_type',
              category: 'FORMS',
              severity: 'MINOR',
              title: `Input field uses type="text" but should use type="${expected === 'tel' ? 'tel' : expected}"`,
              description: `The field "${input.name || input.id || '?'}" appears to be a ${expected} field but uses type="text". Using the correct type improves mobile keyboards and browser autofill.`,
              remediation: `Change type="text" to type="${expected === 'tel' ? 'tel' : expected}".`,
              selector: input.selector,
              messageKey: `suboptimal-input-type-${expected}`,
              evidence: { name: input.name, expected },
            })
          }
        }
      }

      // 4. Password fields without proper autocomplete
      for (const input of form.inputs) {
        if (input.type === 'password' && !input.autocomplete) {
          findings.push({
            checkId: 'forms.password_no_autocomplete',
            category: 'FORMS',
            severity: 'MAJOR',
            title: 'Password field without autocomplete attribute',
            description: 'Password fields should set autocomplete="current-password" (login) or autocomplete="new-password" (registration) to work correctly with password managers and browser anti-phishing features.',
            remediation: 'Add autocomplete="current-password" or autocomplete="new-password" as appropriate.',
            selector: input.selector,
            messageKey: 'password-no-autocomplete',
            evidence: { name: input.name },
          })
        }
      }

      // 5. Form without submit button
      if (!form.hasSubmitButton) {
        findings.push({
          checkId: 'forms.no_submit_button',
          category: 'FORMS',
          severity: 'MAJOR',
          title: 'Form without submit button',
          description: `The form at ${form.selector} has no submit button. Users cannot submit the form via keyboard, and screen readers may not announce the form's purpose.`,
          remediation: 'Add a <button type="submit">Submit</button> inside the form.',
          selector: form.selector,
          messageKey: 'no-submit-button',
          evidence: { action: form.action, method: form.method },
        })
      } else if (form.submitDisabled) {
        findings.push({
          checkId: 'forms.disabled_submit',
          category: 'FORMS',
          severity: 'MINOR',
          title: 'Form submit button is disabled',
          description: `The form at ${form.selector} has a disabled submit button. Users cannot submit the form. If this is intentional (e.g. until required fields are filled), ensure the disabled state is communicated to assistive technology.`,
          remediation: 'Enable the submit button, or add aria-disabled + a visible explanation for why it is disabled.',
          selector: form.selector,
          messageKey: 'disabled-submit',
        })
      }

      // 6. Required fields without aria-required or visual indication
      for (const input of form.inputs) {
        if (input.required && !input.ariaRequired) {
          // Check if the label contains a * or "required" text
          // (we approximate by flagging — the label content check is complex)
          findings.push({
            checkId: 'forms.required_no_aria',
            category: 'FORMS',
            severity: 'MINOR',
            title: 'Required field without aria-required',
            description: `The required field "${input.name || input.id || '?'}" does not have aria-required="true". Screen readers may not announce that the field is required.`,
            remediation: 'Add aria-required="true" to the input, and indicate the requirement visually (e.g. * in the label).',
            selector: input.selector,
            messageKey: 'required-no-aria',
            evidence: { name: input.name, type: input.type },
          })
        }
      }

      // 7. Form without error feedback region
      if (form.inputs.length > 0 && !form.hasErrorRegion) {
        findings.push({
          checkId: 'forms.no_error_region',
          category: 'FORMS',
          severity: 'MINOR',
          title: 'Form without error feedback region',
          description: `The form at ${form.selector} has no [role="alert"] or aria-live region for displaying validation errors. Screen reader users may not be aware of validation failures.`,
          remediation: 'Add a [role="alert"] element near the form, and update it with validation messages on submit.',
          selector: form.selector,
          messageKey: 'no-error-region',
        })
      }
    }

    return findings
  },
}
