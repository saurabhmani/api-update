export type VerificationStatus = 'verified' | 'anonymized' | 'placeholder';

export const brand = {
  name: 'Quantorus',
  url: 'https://quantorus.example',
  headline: 'Intelligence engineered for meaningful progress.',
  description: 'Quantorus combines strategy, software, data, cloud, and AI to help ambitious organizations modernize operations, create better digital experiences, and move from possibility to measurable results.',
  contactEmail: 'hello@quantorus.example',
};

export const services = [
  { slug: 'ai-data-automation', name: 'AI, Data & Intelligent Automation', short: 'Make complex information useful, repeatable, and ready for action.', challenges: ['Information spread across systems', 'Manual, error-prone workflows', 'Unclear path from data to decisions'], capabilities: ['Data foundations', 'Applied AI workflows', 'Operational automation'], technologies: ['Python', 'TypeScript', 'SQL', 'Cloud APIs'] },
  { slug: 'digital-product-engineering', name: 'Digital Product Engineering', short: 'Build dependable digital products that people can use and teams can evolve.', challenges: ['Slow product delivery', 'Legacy user experiences', 'Disconnected customer journeys'], capabilities: ['Product delivery', 'Web applications', 'Platform integration'], technologies: ['Next.js', 'React', 'Node.js', 'PostgreSQL'] },
  { slug: 'cloud-platform-modernization', name: 'Cloud & Platform Modernization', short: 'Create resilient foundations for the next phase of growth.', challenges: ['Hard-to-change platforms', 'Unreliable release processes', 'Scaling constraints'], capabilities: ['Architecture assessment', 'Cloud migration', 'Delivery automation'], technologies: ['AWS', 'Docker', 'CI/CD', 'Observability'] },
  { slug: 'business-process-automation', name: 'Business Process Automation', short: 'Turn repetitive operational work into reliable, visible systems.', challenges: ['Manual handoffs', 'Inconsistent processes', 'Limited operational visibility'], capabilities: ['Workflow mapping', 'Systems integration', 'Process intelligence'], technologies: ['APIs', 'Automation platforms', 'Analytics'] },
  { slug: 'experience-design', name: 'Experience Design', short: 'Make complicated services feel clear, useful, and human.', challenges: ['Low adoption', 'Unclear customer journeys', 'Inconsistent interfaces'], capabilities: ['Research', 'Service design', 'Design systems'], technologies: ['Figma', 'Prototyping', 'Design systems'] },
  { slug: 'technology-strategy', name: 'Technology Strategy & Consulting', short: 'Align technology decisions with business priorities and execution.', challenges: ['Unclear investment priorities', 'Fragmented roadmaps', 'Delivery risk'], capabilities: ['Technology roadmaps', 'Operating models', 'Delivery planning'], technologies: ['Discovery workshops', 'Architecture reviews', 'Roadmapping'] },
] as const;

export const industries = [
  { slug: 'technology-saas', name: 'Technology & SaaS', headline: 'Products and platforms built for change.', challenges: ['Rapidly evolving customer expectations', 'Complex platform decisions', 'Pressure to deliver without compromising quality'] },
  { slug: 'professional-services', name: 'Professional Services', headline: 'More connected operations for expert teams.', challenges: ['Knowledge trapped in teams', 'Manual delivery processes', 'Fragmented client experiences'] },
] as const;

export const caseStudies = [
  { slug: 'digital-platform-placeholder', title: 'A clearer path from operational complexity to a digital platform', industry: 'Technology & SaaS', service: 'Digital Product Engineering', challenge: 'A client engagement requires confirmation before public detail can be shared.', solution: 'Placeholder — replace with a verified, client-approved project summary.', result: 'Outcome details pending verification.', verificationStatus: 'placeholder' as VerificationStatus, sourceNotes: 'Upwork profile endpoint was not publicly accessible during site build. Replace with approved source material.' },
  { slug: 'automation-workflow-placeholder', title: 'Designing a more reliable workflow for a growing operation', industry: 'Professional Services', service: 'Business Process Automation', challenge: 'A client engagement requires confirmation before public detail can be shared.', solution: 'Placeholder — replace with a verified, client-approved project summary.', result: 'Outcome details pending verification.', verificationStatus: 'placeholder' as VerificationStatus, sourceNotes: 'Upwork profile endpoint was not publicly accessible during site build. Replace with approved source material.' },
  { slug: 'data-decision-placeholder', title: 'Making business data easier to understand and act on', industry: 'Technology & SaaS', service: 'AI, Data & Intelligent Automation', challenge: 'A client engagement requires confirmation before public detail can be shared.', solution: 'Placeholder — replace with a verified, client-approved project summary.', result: 'Outcome details pending verification.', verificationStatus: 'placeholder' as VerificationStatus, sourceNotes: 'Upwork profile endpoint was not publicly accessible during site build. Replace with approved source material.' },
] as const;

export const jobs: readonly [] = [];

export const navItems = [
  { label: 'What we do', href: '/services' }, { label: 'Industries', href: '/industries' }, { label: 'Resources', href: '/resources' }, { label: 'About', href: '/about' }, { label: 'Careers', href: '/careers' }, { label: 'Contact', href: '/contact' },
];
