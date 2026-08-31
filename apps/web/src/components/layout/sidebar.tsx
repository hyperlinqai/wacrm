"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { useUnreadNotifications } from "@/hooks/use-unread-notifications";
import {
  Bell,
  Bot,
  FileText,
  GitBranch,
  LayoutDashboard,
  LayoutTemplate,
  LogOut,
  MessageSquare,
  Radio,
  Settings,
  User,
  Users,
  Workflow,
  X,
  Zap,
  ShieldCheck,
} from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslations } from "next-intl";

interface NavItemDef {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  isActive: boolean;
  unreadDot?: boolean;
  badge?: number;
}

interface NavGroupDef {
  id: string;
  label: string;
  items: NavItemDef[];
}

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
}

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const t = useTranslations("Sidebar");
  const pathname = usePathname();
  const { profile, account, accountRole, signOut } = useAuth();
  const totalUnread = useTotalUnread();
  const unreadNotifications = useUnreadNotifications();

  // Close drawer on path change (mobile)
  useEffect(() => {
    onClose?.();
  }, [pathname, onClose]);

  // Lock scroll and handle Escape (mobile)
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const initial = account?.name?.charAt(0)?.toUpperCase() ?? "T";

  // Navigation Menu groups organized by functional areas
  const navGroups: NavGroupDef[] = [
    {
      id: "work",
      label: "Work & Inbox",
      items: [
        {
          href: "/dashboard",
          label: t("dashboard") || "Dashboard",
          icon: LayoutDashboard,
          isActive: pathname === "/dashboard",
        },
        {
          href: "/inbox",
          label: "Live Chat",
          icon: MessageSquare,
          isActive: pathname.startsWith("/inbox"),
          unreadDot: totalUnread > 0,
        },
        {
          href: "/contacts",
          label: t("contacts") || "Contacts",
          icon: Users,
          isActive: pathname.startsWith("/contacts"),
        },
        {
          // Deliberately no badge: the sidebar is mounted on every page,
          // and a count here would mean a contacts query on every
          // navigation. The page itself does the counting.
          href: "/validation",
          label: t("validation") || "Validation",
          icon: ShieldCheck,
          isActive: pathname.startsWith("/validation"),
        },
      ],
    },
    {
      id: "campaigns",
      label: "Campaigns & Outbound",
      items: [
        {
          href: "/broadcasts",
          label: t("broadcasts") || "Broadcasts",
          icon: Radio,
          isActive: pathname.startsWith("/broadcasts"),
        },
        {
          href: "/templates",
          label: t("templates") || "Templates",
          icon: LayoutTemplate,
          isActive: pathname.startsWith("/templates"),
        },
        {
          href: "/web-forms",
          label: t("webForms") || "Web Forms",
          icon: FileText,
          isActive: pathname.startsWith("/web-forms"),
        },
      ],
    },
    {
      id: "automations",
      label: "Automations & AI",
      items: [
        {
          href: "/automations",
          label: t("automations") || "Automations",
          icon: Zap,
          isActive: pathname.startsWith("/automations"),
        },
        {
          href: "/flows",
          label: t("flows") || "Flows",
          icon: Workflow,
          isActive: pathname.startsWith("/flows"),
        },
        {
          href: "/agents",
          label: t("aiAgents") || "AI Agents",
          icon: Bot,
          isActive: pathname.startsWith("/agents"),
        },
      ],
    },
    {
      id: "sales",
      label: "Sales & Deals",
      items: [
        {
          href: "/pipelines",
          label: t("pipelines") || "Pipelines",
          icon: GitBranch,
          isActive: pathname.startsWith("/pipelines"),
        },
      ],
    },
    {
      id: "system",
      label: "System",
      items: [
        {
          href: "/notifications",
          label: t("notifications") || "Notifications",
          icon: Bell,
          isActive: pathname.startsWith("/notifications"),
          badge: unreadNotifications,
        },
        {
          href: "/settings",
          label: t("settings") || "Settings",
          icon: Settings,
          isActive: pathname.startsWith("/settings"),
        },
      ],
    },
  ];

  return (
    <>
      {/* Mobile Backdrop */}
      <button
        type="button"
        aria-label={t("closeMenu")}
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-background/70 backdrop-blur-sm transition-opacity lg:hidden",
          open
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0"
        )}
      />

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex h-full w-60 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
          "transition-transform duration-200 ease-out will-change-transform",
          open ? "translate-x-0" : "-translate-x-full",
          "lg:static lg:z-0 lg:w-60 lg:translate-x-0 lg:transition-none"
        )}
        aria-label="Primary"
      >
        {/* Brand Logo and Title Row */}
        <div className="flex h-16 shrink-0 items-center gap-3 px-4 border-b border-sidebar-border/30">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#E2F9C4] text-[#083B3C] font-extrabold text-sm select-none shadow-sm shrink-0">
            {initial}
          </div>
          <span className="truncate text-sm font-semibold tracking-tight text-white font-sans">
            {t("title") || "WA-CRM"}
          </span>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={t("closeMenu")}
              className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-[#9FBAB8] hover:bg-white/10 hover:text-white lg:hidden"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Scrollable Navigation Groups */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
          {navGroups.map((group) => (
            <div key={group.id} className="space-y-1.5">
              <h4 className="px-3 text-[10px] font-semibold tracking-wider text-[#9FBAB8]/60 uppercase">
                {group.label}
              </h4>
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors w-full",
                        item.isActive
                          ? "bg-white/10 text-white"
                          : "text-[#9FBAB8] hover:bg-white/5 hover:text-white"
                      )}
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.unreadDot && (
                        <span className="relative flex h-2 w-2">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                        </span>
                      )}
                      {item.badge !== undefined && item.badge > 0 && (
                        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[#10B981] px-1 text-[10px] font-semibold text-white">
                          {item.badge > 9 ? "9+" : item.badge}
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        {/* User Account / Profile Dropdown at the bottom */}
        <div className="shrink-0 border-t border-sidebar-border p-3">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-white/5 focus:outline-none"
                />
              }
            >
              <Avatar className="size-8 shrink-0">
                {profile?.avatar_url ? (
                  <AvatarImage
                    src={profile.avatar_url}
                    alt={profile.full_name ?? t("defaultAvatar")}
                  />
                ) : null}
                <AvatarFallback className="bg-white/10 text-xs font-semibold text-white">
                  {profile?.full_name?.charAt(0)?.toUpperCase() ??
                    profile?.email?.charAt(0)?.toUpperCase() ??
                    "U"}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold text-white">
                  {profile?.full_name ?? t("defaultUser")}
                </p>
                <p className="truncate text-[10px] text-[#9FBAB8]/80">
                  {profile?.email ?? ""}
                </p>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="right"
              sideOffset={12}
              className="min-w-56 bg-popover text-popover-foreground border-border rounded-xl shadow-lg"
            >
              <div className="px-3 py-2 text-xs border-b border-border/50">
                <p className="font-semibold text-foreground truncate">
                  {profile?.full_name ?? t("defaultUser")}
                </p>
                <p className="text-muted-foreground truncate text-[11px] mt-0.5">
                  {profile?.email ?? ""}
                </p>
                {account?.name && (
                  <p className="text-primary font-medium text-[10px] uppercase tracking-wide mt-1.5 flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full bg-[#10B981]" />
                    {account.name} ({accountRole})
                  </p>
                )}
              </div>

              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=profile"
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <User className="size-4" />
                {t("menuProfile")}
              </DropdownMenuItem>
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=whatsapp"
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <Settings className="size-4" />
                {t("menuSettings")}
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem
                onClick={signOut}
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <LogOut className="size-4" />
                {t("menuSignOut")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </>
  );
}
