# Quantorus corporate site content

Non-developers can edit all site copy and listings in `src/content/corporate.ts`.

- Homepage message and contact placeholder: `brand`
- Services: `services`
- Industries: `industries`
- Case studies: `caseStudies` (keep `verificationStatus` and internal `sourceNotes` accurate)
- Current vacancies: `jobs`
- Navigation: `navItems`

Before launch, replace the `.example` contact address and site URL, connect `src/app/api/contact/route.ts` to the chosen CRM/email service, add an approved privacy policy, and replace every placeholder case study with client-approved, verifiable content.
