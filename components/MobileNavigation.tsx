"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function MobileNavigation() {
  const pathname = usePathname();
  const homeActive = pathname === "/";
  const dashboardActive = pathname === "/dashboard";

  return (
    <nav aria-label="Mobile navigation" className="mobile-tabbar">
      <Link href="/" aria-current={homeActive ? "page" : undefined} className={homeActive ? "mobile-tab mobile-tab-active" : "mobile-tab"}>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path strokeLinecap="round" strokeLinejoin="round" d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V10Z" />
        </svg>
        <span>Home</span>
      </Link>
      <Link href="/dashboard" aria-current={dashboardActive ? "page" : undefined} className={dashboardActive ? "mobile-tab mobile-tab-active" : "mobile-tab"}>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="3" y="3" width="8" height="8" rx="2" />
          <rect x="13" y="3" width="8" height="5" rx="2" />
          <rect x="13" y="10" width="8" height="11" rx="2" />
          <rect x="3" y="13" width="8" height="8" rx="2" />
        </svg>
        <span>Groups</span>
      </Link>
    </nav>
  );
}
