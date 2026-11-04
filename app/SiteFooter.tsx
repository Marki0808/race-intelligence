import Image from "next/image";
import Link from "next/link";
import PrivacySettingsLink from "./PrivacySettingsLink";

export default function SiteFooter() {
  return (
    <footer className="bg-[#203329] py-8 text-white">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-5 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10">
        <Link href="/" className="w-fit" aria-label="Endurset home">
          <Image src="/brand/endurset-wordmark-dark.png" alt="" width={2015} height={314} className="h-auto w-[145px]" />
        </Link>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-white/70">
          <Link href="/">Home</Link><Link href="/#analyze">Analyze your route</Link><Link href="/#faq">FAQ</Link><Link href="/privacy">Privacy Policy</Link><PrivacySettingsLink />
        </div>
        <p className="text-xs leading-5 text-white/55">Understand the route in your GPX.</p>
      </div>
    </footer>
  );
}
