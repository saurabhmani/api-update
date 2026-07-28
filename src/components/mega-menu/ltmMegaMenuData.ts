import type { Navigation } from './LtmMegaMenu';

export const ltmMegaMenuData: Navigation = {
  logo: { label: 'Quantorus', href: '/' }, contact: { label: 'Contact us', href: '/contact' },
  items: [
    { label: 'What we do', href: '/services', section: { title: 'Capabilities', width: 'wide', columns: [
      { groups: [{ title: 'iRun', links: [{ label: 'Application Management Services', href: '/services/application-management' }, { label: 'Cognitive Infrastructure Services', href: '/services/cognitive-infrastructure' }, { label: 'Cybersecurity', href: '/services/cybersecurity' }] }] },
      { groups: [{ title: 'iTransform', links: [{ label: 'AI-led Engineering', href: '/services/ai-led-engineering' }, { label: 'Data and Analytics', href: '/services/data-analytics' }, { label: 'Enterprise Applications', href: '/services/enterprise-applications' }, { label: 'Interactive', href: '/services/interactive' }, { label: 'Industry.NXT', href: '/services/industry-next' }] }, { title: 'Business AI', links: [{ label: 'Business AI', href: '/services/business-ai' }] }] },
      { groups: [{ title: 'BlueVerse', links: [{ label: 'BlueVerse', href: '/services/blueverse' }] }] },
      { groups: [{ title: 'Proprietary Offerings', links: [{ label: 'GCC-as-a-Service', href: '/services/gcc-as-a-service' }, { label: 'Unitrax', href: '/services/unitrax' }, { label: 'Voicing AI', href: '/services/voicing-ai' }] }] },
    ] } },
    { label: 'Industries we serve', href: '/industries', section: { title: 'Industries', columns: [{ groups: [{ links: [{ label: 'Automotive', href: '/industries/automotive' }, { label: 'Industrial Products', href: '/industries/industrial-products' }, { label: 'Medical Devices', href: '/industries/medical-devices' }] }] }, { groups: [{ links: [{ label: 'Aerospace and Defense', href: '/industries/aerospace-defense' }, { label: 'Telecom and Hi-Tech', href: '/industries/technology-saas' }, { label: 'Sustainability', href: '/industries/sustainability' }] }] }, { groups: [{ links: [{ label: 'Trucks and Off-highway', href: '/industries/trucks-off-highway' }, { label: 'Plant Engineering', href: '/industries/manufacturing' }, { label: 'Rail Transportation', href: '/industries/rail-transportation' }] }] }] } },
    { label: 'About us', href: '/about', section: { title: 'About us', columns: [{ groups: [{ links: [{ label: 'Our story', href: '/about' }, { label: 'Leadership', href: '/about#leadership' }, { label: 'Sustainability', href: '/about#sustainability' }] }] }, { groups: [{ links: [{ label: 'Newsroom', href: '/insights' }, { label: 'Investor relations', href: '/about#investors' }, { label: 'Contact', href: '/contact' }] }] }] } },
    { label: 'Careers', href: '/careers' },
  ],
};
