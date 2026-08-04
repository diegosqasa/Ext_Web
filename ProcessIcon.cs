using System.Drawing;
using System.Drawing.Drawing2D;

namespace ImageModifier {
    public class Modifier {
        public static void Process() {
            Bitmap img = new Bitmap("SQA.png");
            Bitmap newImg = new Bitmap(img.Width, img.Height);
            using (Graphics g = Graphics.FromImage(newImg)) {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                
                // Draw a dark rounded rectangle
                int r = img.Width / 5;
                GraphicsPath path = new GraphicsPath();
                path.AddArc(0, 0, r, r, 180, 90);
                path.AddArc(img.Width - r, 0, r, r, 270, 90);
                path.AddArc(img.Width - r, img.Height - r, r, r, 0, 90);
                path.AddArc(0, img.Height - r, r, r, 90, 90);
                path.CloseAllFigures();
                
                g.FillPath(new SolidBrush(Color.FromArgb(40, 44, 52)), path); // Dark background
                g.DrawImage(img, 0, 0);
            }
            newImg.Save("SQA_dark.png", System.Drawing.Imaging.ImageFormat.Png);
        }
    }
}
