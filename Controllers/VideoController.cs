using Microsoft.AspNetCore.Mvc;

namespace Video_Call.Controllers
{
    public class VideoController : Controller
    {
        public IActionResult Index()
        {
            return View();
        }


    }
}
