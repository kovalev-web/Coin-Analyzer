import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner } from "sonner";
import { useSiteTheme } from "@/shared/use-site-theme"

// Our theme (data-theme on <html> or the system one) instead of next-themes
const Toaster = ({
  ...props
}) => {
  const theme = useSiteTheme()

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--paper)",
          "--normal-text": "var(--ink-deep)",
          "--normal-border": "var(--fog)",
          "--border-radius": "var(--radius-md)"
        }
      }
      {...props} />
  );
}

export { Toaster }
