import Image from 'next/image'; import Link from 'next/link';
import { ArrowUpRight, Bot, Cloud, Database, LockKeyhole, Workflow, Boxes, Monitor, Compass } from 'lucide-react';
import SiteShell from '@/components/corporate/SiteShell';
import { Reveal } from '@/components/corporate/Reveal';
import { brand, caseStudies, industries, insights, services, technologies } from '@/content/corporate';

const icons = [Bot, Database, Cloud, LockKeyhole, Monitor, Boxes, Workflow, Compass];
export const metadata = { title: 'Technology engineered for meaningful business progress', description: brand.description, alternates: { canonical: '/' } };
export default function Home() {
    return <SiteShell>
        <section className="q-hero">
            <div className="q-hero-grid" />
            <div className="q-hero-art">
                <Image src="/images/quantorus-technology-hero.png" alt="Abstract technology infrastructure composition" fill priority sizes="(max-width: 760px) 100vw, 58vw" />
            </div>
            <div className="q-hero-inner">
                <p className="q-eyebrow">Strategy · Engineering · Technology</p>
                <h1>Technology engineered for <em>meaningful business progress.</em>
                </h1>
                <p className="q-lede">{brand.description}</p>
                <div className="q-actions">
                    <Link className="q-talk" href="/contact">Talk to our experts <ArrowUpRight size={16} />
                    </Link>
                    <Link className="q-link q-dark-link" href="/services">Explore our services <ArrowUpRight size={16} />
                    </Link>
                </div>
            </div>
        </section>
        <section className="q-section">
            <div className="q-container q-intro">
                <Reveal>
                    <p className="q-eyebrow">The Quantorus approach</p>
                    <h2>From complex technology choices to useful momentum.</h2>
                </Reveal>
                <Reveal delay={.1}>
                    <p className="q-body">Quantorus helps organisations modernise the systems behind their operations and customer experiences. We combine business context with practical delivery to create platforms that are clearer to use, easier to evolve, and ready for what comes next.</p>
                    <div className="q-service-list">{['Modernise operations', 'Build scalable platforms', 'Make data more useful', 'Deliver with security in mind'].map((x, i) => <div className="q-service" key={x}>
                        <span>0{i + 1}</span>
                        <h3>{x}</h3>
                        <ArrowUpRight />
                    </div>)}
                    </div>
                </Reveal>
            </div>
        </section>
        <section className="q-section alt">
            <div className="q-container">
                <p className="q-eyebrow">Services & solutions</p>
                <h2>Capabilities connected to the work.</h2>
                <div className="q-card-grid">{services.slice(0, 8).map((s, i) => {
                    const Icon = icons[i]; return <article className="q-card" key={s.slug}>
                        <div>
                            <Icon size={25} color="#d71920" />
                            <h3>{s.name}</h3>
                            <p>{s.short}</p>
                        </div>
                        <Link className="q-link" href={`/services/${s.slug}`}>Explore service <ArrowUpRight size={16} />
                        </Link>
                    </article>
                })}
                </div>
            </div>
        </section>
        <section className="q-section">
            <div className="q-container">
                <div className="q-intro">
                    <div>
                        <p className="q-eyebrow">Industries we serve</p>
                        <h2>Technology that understands the operating context.</h2>
                    </div>
                    <p className="q-body">Our industry pages are structured as editable working content. They make room for the priorities, constraints, and customer expectations that shape each sector.</p>
                </div>
                <div className="q-card-grid">{industries.slice(0, 6).map(i => <article className="q-card" key={i.slug}>
                    <div>
                        <p className="q-eyebrow">Draft industry focus</p>
                        <h3>{i.name}</h3>
                        <p>{i.headline}</p>
                    </div>
                    <Link className="q-link" href={`/industries/${i.slug}`}>Explore industry <ArrowUpRight size={16} />
                    </Link>
                </article>)}
                </div>
            </div>
        </section>
        <section className="q-section alt">
            <div className="q-container">
                <p className="q-eyebrow">Featured case studies
                </p>
                <h2>Work designed around a real business challenge.
                </h2>
                <div className="q-card-grid">{caseStudies.map(c => <article className="q-card" key={c.slug}>
                    <div>
                        <p className="q-eyebrow">{c.industry} · {c.verificationStatus}
                        </p>
                        <h3>{c.title}
                        </h3>
                        <p>{c.challenge}
                        </p>
                        <div className="q-tags">
                            <span className="q-tag">{c.service}
                            </span>
                        </div>
                    </div>
                    <Link className="q-link" href={`/case-studies/${c.slug}`}>View case study <ArrowUpRight size={16} />
                    </Link>
                </article>)}
                </div>
            </div>
        </section>
        <section className="q-section">
            <div className="q-container">
                <p className="q-eyebrow">Technology capabilities
                </p>
                <h2>Practical foundations for change.
                </h2>
                <div className="q-capabilities">{technologies.map(t => <Link className="q-capability" href={`/technologies/${t.slug}`} key={t.slug}>
                    <span className="q-eyebrow">Capability
                    </span>
                    <h3>{t.name}
                    </h3>
                    <p>{t.description}
                    </p>
                </Link>)}
                </div>
            </div>
        </section>
        <section className="q-section alt">
            <div className="q-container">
                <div className="q-intro">
                    <div>
                        <p className="q-eyebrow">Delivery approach
                        </p>
                        <h2>Clear stages. Connected delivery.
                        </h2>
                    </div>
                    <p className="q-body">We reduce uncertainty early and keep delivery focused on the value that prompted the work in the first place.
                    </p>
                </div>
                <div className="q-steps">{[['01', 'Discover', 'Understand requirements, context, and constraints.'], ['02', 'Design', 'Shape a focused solution and delivery path.'], ['03', 'Engineer', 'Build secure, adaptable technology with care.'], ['04', 'Evolve', 'Measure, improve, and keep useful systems moving.']].map(x => <div className="q-step" key={x[1]}>
                    <span>{x[0]}
                    </span>
                    <h3>{x[1]}
                    </h3>
                    <p>{x[2]}
                    </p>
                </div>)}
                </div>
            </div>
        </section>
        <section className="q-section">
            <div className="q-container">
                <p className="q-eyebrow">Why Quantorus
                </p>
                <h2>Senior, transparent, and built for the long view.
                </h2>
                <div className="q-why">{[['Business-aligned engineering', 'Technology choices remain connected to the operating outcome.'], ['Senior technical involvement', 'Experienced practitioners stay close to the important decisions.'], ['Transparent collaboration', 'Clear communication makes progress visible and actionable.'], ['Scalable architecture', 'Foundations are built to support the next useful change.'], ['Security-conscious implementation', 'Security considerations inform delivery from the start.'], ['Long-term optimisation', 'We help teams improve what they build, not simply launch it.']].map(x => <div key={x[0]}>
                    <h3>{x[0]}
                    </h3>
                    <p>{x[1]}
                    </p>
                </div>)}
                </div>
            </div>
        </section>
        <section className="q-section alt">
            <div className="q-container">
                <p className="q-eyebrow">Insights
                </p>
                <h2>Useful thinking for technology leaders.
                </h2>
                <div className="q-card-grid">{insights.map(i => <article className="q-card" key={i.slug}>
                    <div>
                        <p className="q-eyebrow">{i.category}
                        </p>
                        <h3>{i.title}
                        </h3>
                        <p>{i.excerpt}
                        </p>
                    </div>
                    <Link className="q-link" href={`/insights/${i.slug}`}>Read insight <ArrowUpRight size={16} />
                    </Link>
                </article>)}</div>
            </div>
        </section>
        <section className="q-section">
            <div className="q-container q-scheme">
                <p className="q-eyebrow">Careers</p>
                <h2>Build what’s next with Quantorus.</h2>
                <p>See current requirements and future opportunities in one place.</p>
                <Link className="q-talk" href="/careers">Explore careers <ArrowUpRight size={16} />
                </Link>
            </div>
        </section>
        <section className="q-section alt">
            <div className="q-container q-scheme">
                <p className="q-eyebrow">Start a conversation</p>
                <h2>Ready to turn your technology priorities into measurable progress?</h2>
                <p>Tell us about the challenge. We’ll begin with the context that matters to your organisation.</p>
                <Link className="q-talk" href="/contact">Request a consultation <ArrowUpRight size={16} />
                </Link>
            </div>
        </section>
    </SiteShell>;
}
