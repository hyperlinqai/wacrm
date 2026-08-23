import { cn } from "@/lib/utils";

export function BrandMark({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md bg-primary font-bold tracking-tight text-primary-foreground",
        size === "sm" && "h-7 w-7 text-[9px]",
        size === "md" && "h-8 w-8 text-[10px]",
        size === "lg" && "h-12 w-12 rounded-xl text-sm",
        className,
      )}
      aria-hidden
    >
      HQ
    </div>
  );
}
