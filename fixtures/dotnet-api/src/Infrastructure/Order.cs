namespace Infrastructure;

/// <summary>
/// One entity is enough. The fixture exists to exercise the pipeline, not to model a domain.
/// </summary>
public class Order
{
    public int Id { get; set; }
    public string Reference { get; set; } = "";
    public decimal Total { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}
