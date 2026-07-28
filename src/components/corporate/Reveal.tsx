'use client';
import { motion, useReducedMotion } from 'framer-motion';
export function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) { const reduce = useReducedMotion(); return <motion.div initial={reduce ? false : { opacity: 0, y: 18 }} whileInView={reduce ? {} : { opacity: 1, y: 0 }} viewport={{ once: true, amount: .15 }} transition={{ duration: .55, delay }}>{children}</motion.div>; }
