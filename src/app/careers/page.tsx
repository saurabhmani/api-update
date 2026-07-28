import SiteShell from '@/components/corporate/SiteShell';
import CareerList from '@/components/corporate/CareerList';
import { PageHero, Section, CTA } from '@/components/corporate/PageParts';
import { jobs } from '@/content/corporate';
export const metadata={title:'Careers',description:'Current Quantorus opportunities and how to get in touch.',alternates:{canonical:'/careers'}};
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
export default function Careers(){return <SiteShell><PageHero eyebrow="Careers" title="Build what’s next with Quantorus." body="Explore current opportunities, or introduce yourself for future roles." crumbs={[{label:'Careers'}]}/><Section><p className="q-eyebrow">Current opportunities · {jobs.length}</p><CareerList opportunities={jobs}/><p className="q-body" style={{marginTop:35}}>Quantorus is committed to fair consideration for qualified applicants. Current roles are managed in the centralized content file. We are an equal opportunity organisation.</p></Section><CTA/></SiteShell>}
